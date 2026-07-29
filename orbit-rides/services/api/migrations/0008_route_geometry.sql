-- 0008 · Geometría de la ruta, para dibujarla en el mapa
--
-- OSRM ya devolvía el trazado: la llamada pide `geometries=polyline6` y
-- `RouteResult.polyline` lo recibía. Pero no había dónde guardarlo, así que se
-- calculaba y se descartaba en el borde del API. El resultado era que las apps
-- solo podían dibujar una línea recta entre origen y destino, que en una ciudad
-- no se parece al camino real.
--
-- Se guarda el texto codificado tal como viene, no una geometría de PostGIS.
-- Razón: nadie consulta espacialmente sobre este dato. Solo viaja al cliente
-- para pintarse. Meterlo en GEOGRAPHY(LINESTRING) obligaría a convertir de ida
-- y de vuelta en cada lectura sin ganar nada.
--
-- El formato es polyline6 (precisión de 6 decimales), NO el polyline5 clásico
-- de Google. Decodificarlo con un decodificador de 5 lo dibuja a 100 km del
-- lugar correcto, que es un error silencioso y muy confuso.

ALTER TABLE quotes ADD COLUMN route_polyline TEXT;

COMMENT ON COLUMN quotes.route_polyline IS
  'Trazado origen→destino en polyline6. Deliberadamente FUERA del signed_payload: '
  'no interviene en el precio, y sumarlo a la firma rompería las cotizaciones '
  'vivas al desplegar. La tarifa la protegen distanceMeters y durationSeconds, '
  'que sí están firmados.';

ALTER TABLE trips ADD COLUMN route_polyline  TEXT;
ALTER TABLE trips ADD COLUMN pickup_polyline TEXT;

COMMENT ON COLUMN trips.route_polyline IS
  'Copia del trazado de la cotización al crear el viaje. Se copia en vez de leerse '
  'por join porque el viaje es el registro histórico: si la cotización se borrara '
  'por retención de datos, el viaje conserva lo que se recorrió.';

COMMENT ON COLUMN trips.pickup_polyline IS
  'Trazado del conductor hacia el origen, calculado al aceptar. Nullable: si OSRM '
  'no responde en ese momento el viaje se acepta igual y la app cae a la línea '
  'recta. Un proveedor de mapas caído no puede impedir que un conductor tome un '
  'viaje.';
