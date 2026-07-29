-- 0009 · Maniobras de la ruta, para el cartel de navegación
--
-- La 0008 guardó el TRAZADO —por dónde va la ruta—. Esto guarda las MANIOBRAS
-- —dónde hay que girar y hacia dónde—, que es lo que hace falta para el cartel
-- de «girá a la derecha en 200 m, Avenida Brasil».
--
-- Se guarda como JSONB y no en una tabla aparte. La razón es cómo se usa: los
-- pasos se leen SIEMPRE completos y SIEMPRE junto con el viaje, nunca se
-- consultan de a uno ni se filtran ni se cruzan con nada. Una tabla hija con su
-- índice y su join costaría más de lo que resuelve. Si algún día hiciera falta
-- analizar maniobras —cuántos giros a la izquierda por viaje, por ejemplo— se
-- normaliza entonces, con el caso de uso a la vista.
--
-- Forma de cada elemento, tal como la emite services/api/src/lib/routing.ts:
--
--   {
--     "distanceMeters": 240,
--     "durationSeconds": 31,
--     "name": "Avenida Brasil",
--     "type": "turn",
--     "modifier": "right",
--     "at": { "lat": -34.9112, "lng": -56.1553 },
--     "exit": null
--   }
--
-- `type` y `modifier` quedan con los nombres crudos de OSRM. La traducción al
-- castellano vive en el cliente: si se cambia de proveedor de ruteo, se adapta
-- el mapeo en un archivo y el contenido de esta columna no obliga a migrar.

ALTER TABLE quotes ADD COLUMN route_steps JSONB;

COMMENT ON COLUMN quotes.route_steps IS
  'Maniobras origen→destino. Fuera del signed_payload, igual que route_polyline: '
  'no interviene en el precio.';

ALTER TABLE trips ADD COLUMN route_steps  JSONB;
ALTER TABLE trips ADD COLUMN pickup_steps JSONB;

COMMENT ON COLUMN trips.route_steps IS
  'Maniobras del viaje, copiadas de la cotización al crearlo.';

COMMENT ON COLUMN trips.pickup_steps IS
  'Maniobras del conductor hacia el origen, calculadas al aceptar. Nullable: si '
  'OSRM no responde, el viaje se acepta igual y la app navega sin cartel.';
