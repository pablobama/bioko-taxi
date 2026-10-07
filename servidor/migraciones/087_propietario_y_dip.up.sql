-- 087 — El propietario del taxi, el DIP, y dos tipos más de vehículo (08/10).
--
-- Hasta hoy todo colgaba de una sola ficha, el conductor: la cuenta que entra,
-- recibe carreras, lleva el monedero y la reputación. Y se daba por hecho que
-- quien conduce es el dueño del coche. En Malabo no siempre: hay dueños con
-- dos o tres taxis y conductores que trabajan el coche de otro.
--
-- LO QUE SE SEPARA, y lo que NO. El conductor sigue siendo la cuenta operativa
-- —el dinero, las carreras, los strikes y la cuota son suyos, responde quien
-- conduce—; solo gana apellido y DIP. El PROPIETARIO es nuevo, y es SOLO un
-- registro: quién responde legalmente del coche y a quién llamar. No entra en
-- la app, no conduce, no cobra. Un mismo propietario (mismo DIP) puede figurar
-- en varios vehículos: es la flota.
--
-- EL DIP es el documento de identidad (nueve dígitos). Identifica a la persona
-- de verdad, mejor que el teléfono —que se comparte y se cambia—, así que es
-- la clave única de cada propietario y de cada conductor. La misma persona
-- puede ser dueña Y conducir: entonces su DIP aparece en las dos tablas, que
-- es correcto, son dos papeles distintos de la misma persona.

CREATE TABLE propietario (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nombre     text NOT NULL,
  apellido   text NOT NULL,
  -- En forma canónica, como en todas partes (migración 024). No es la
  -- identidad del propietario —lo es el DIP—: es solo para llamarle.
  telefono   text NOT NULL,
  -- Nueve dígitos. UNIQUE: un DIP, un propietario. Volver a darlo de alta
  -- reutiliza su ficha y le cuelga otro coche.
  dip        text NOT NULL UNIQUE CHECK (dip ~ '^[0-9]{9}$'),
  creado_en  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE propietario ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE propietario IS
  'El dueño del taxi (migración 087). Solo registro: nombre, teléfono y DIP de '
  'quien responde del coche. No es una cuenta y no cobra; puede figurar en '
  'varios vehículos (flota). El dinero y la responsabilidad son del conductor.';

-- El conductor gana apellido y DIP. Nulos por ahora: hay conductores de antes
-- de esto, y un alta que reviente por un campo que nadie les pidió es peor que
-- una ficha a completar. Las altas nuevas los exigen, en la ruta.
ALTER TABLE conductor ADD COLUMN apellido text;
ALTER TABLE conductor ADD COLUMN dip text CHECK (dip ~ '^[0-9]{9}$');

-- Un DIP, un conductor —entre los que lo tienen—. Parcial, porque los viejos
-- lo tienen a null y null no choca con null en un índice único normal, pero
-- aquí se deja explícito para que se lea la intención.
CREATE UNIQUE INDEX conductor_dip ON conductor (dip) WHERE dip IS NOT NULL;

COMMENT ON COLUMN conductor.dip IS
  'Documento de identidad, nueve dígitos (migración 087). Único entre '
  'conductores; puede coincidir con un propietario si la misma persona es '
  'dueña y conduce.';

-- De quién es el coche. Nulo para los vehículos de antes: se completa cuando
-- el operador repase la ficha. Las altas nuevas lo exigen.
ALTER TABLE vehiculo ADD COLUMN propietario_id bigint REFERENCES propietario (id);
CREATE INDEX vehiculo_propietario ON vehiculo (propietario_id) WHERE propietario_id IS NOT NULL;

-- Dos tipos más de vehículo. Informativos: describen el coche para el
-- pasajero. Las PLAZAS del taxi compartido (migración 013) no se tocan —siguen
-- de 1 a 4— porque cuántas carreras simultáneas acepta una furgoneta es una
-- política de despacho aparte, no un dato del alta.
ALTER TABLE vehiculo DROP CONSTRAINT vehiculo_carroceria_check;
ALTER TABLE vehiculo ADD CONSTRAINT vehiculo_carroceria_check
  CHECK (carroceria IN ('turismo', '4x4', 'furgoneta', 'autobus'));
