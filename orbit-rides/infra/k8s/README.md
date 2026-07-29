# Kubernetes — para después, no para ahora

Estos manifests están escritos y son correctos, pero **no los uses todavía**.

## Por qué esperar

Docker Compose y Kubernetes resuelven problemas distintos:

- **Compose** resuelve "quiero levantar tres contenedores en mi máquina".
- **Kubernetes** resuelve "tengo N réplicas de M servicios en varias máquinas y
  necesito que se reprogramen solas cuando una se cae".

Con un servicio y un equipo chico, k8s te agrega un plano de control que hay que
operar, versionar y debuggear, y no te compra nada que Compose o un PaaS no te
den. El costo real no es el YAML: es que cada incidente ahora tiene una capa más
donde puede estar el problema.

## Cuándo migrar

Cuando se cumpla al menos una:

1. Necesitás más de una instancia del API por disponibilidad, no por carga.
2. Tenés más de un servicio desplegable con ciclos de vida separados.
3. Ya hay alguien que puede operar un clúster a las 3 de la mañana.
4. El costo de un PaaS supera el de administrar el clúster.

Hasta entonces: Compose en desarrollo, y Fly.io / Railway / ECS para producción.

## Lo que hay que resolver ANTES de escalar a varias réplicas

El worker de dispatch (`services/api/src/workers/dispatcher.ts`) usa timers en
memoria del proceso. Con dos réplicas, las dos podrían despachar el mismo viaje.

Hoy eso **no corrompe datos**: la base lo impide con el índice único
`trips_one_active_per_driver` y con el `UPDATE` condicional de `assignDriver`.
El peor caso es trabajo duplicado y una oferta de más.

Pero antes de subir `replicas` hay que reemplazar los timers por una cola real:

```
npm i bullmq --workspace @orbit/api
```

y mover la cadena de olas a un `Worker` de BullMQ con `jobId = tripId`, que
garantiza una sola ejecución por viaje en todo el clúster. El hub de WebSocket
(`src/ws/hub.ts`) también necesita un adapter de Redis pub/sub para que un
mensaje publicado en la réplica A llegue al socket conectado a la réplica B.

**Los dos límites están documentados en el código, en el archivo donde importan.**

## Orden de aplicación

```bash
kubectl apply -f namespace.yaml
kubectl apply -f configmap.yaml
# Editá secret.yaml con valores reales antes de aplicarlo, o usá un gestor
# externo (Sealed Secrets, External Secrets, SOPS). No lo commitees con datos.
kubectl apply -f secret.yaml
kubectl apply -f redis.yaml
kubectl apply -f migrate-job.yaml   # esperá que termine
kubectl apply -f api.yaml
```

Postgres no está acá a propósito: una base de datos con estado en el clúster es
una decisión que hay que tomar deliberadamente. Usá un servicio administrado
(RDS, Cloud SQL, Neon) salvo que tengas una razón muy concreta.
