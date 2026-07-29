-- 0007 · Guardar el payload firmado, textual
--
-- Antes, al canjear una cotización se RECONSTRUÍA el payload a partir de las
-- columnas normalizadas para verificar el HMAC. Eso era frágil por diseño:
--
--   · el id se generaba dos veces (uno en JS para firmar, otro por
--     gen_random_uuid() al insertar), así que la firma nunca podía verificar;
--   · surge_multiplier vuelve de NUMERIC como string;
--   · issued_at se deducía de expires_at menos el TTL de la config, lo que se
--     rompe en silencio si alguien cambia QUOTE_TTL_SECONDS entre que se
--     cotiza y que se pide el viaje;
--   · lat/lng pasan por geography y vuelven como float8.
--
-- Ahora se guarda el JSON exacto que se firmó. La verificación es sobre ese
-- texto, sin re-derivar nada. Y de paso queda registro literal de lo que el
-- pasajero aceptó, que es lo que importa en una disputa.
--
-- Nullable a propósito: las cotizaciones creadas antes de esta migración no lo
-- tienen, y se rechazan con un mensaje claro en vez de con un 500.

ALTER TABLE quotes ADD COLUMN signed_payload TEXT;

COMMENT ON COLUMN quotes.signed_payload IS
  'JSON exacto que se firmó con HMAC. No re-derivar el payload de las columnas.';
