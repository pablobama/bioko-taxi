// El propietario del taxi y el DIP (migración 087).
//
// El propietario es SOLO un registro —quién responde del coche y a quién
// llamar—, no una cuenta: no entra en la app ni cobra. Su identidad es el DIP,
// no el teléfono, porque el teléfono se comparte y se cambia y el documento
// no. De ahí que darlo de alta dos veces con el mismo DIP reutilice su ficha y
// le cuelgue otro coche: así se registra la flota de un mismo dueño.

import type pg from 'pg';

type Lector = pg.Pool | pg.ClientBase;

// Nueve dígitos, ni uno más. Devuelve el DIP limpio o null si no vale, para
// que quien llama decida el mensaje.
export function dipValido(crudo: string | undefined | null): string | null {
  const limpio = (crudo ?? '').trim();
  return /^[0-9]{9}$/.test(limpio) ? limpio : null;
}

export interface DatosPropietario {
  nombre: string;
  apellido: string;
  // Ya en forma canónica.
  telefono: string;
  // Ya validado: nueve dígitos.
  dip: string;
}

// Reutiliza el propietario de ese DIP, o lo crea. Si ya existía, se le
// refrescan nombre, apellido y teléfono: el documento manda sobre quién es, y
// lo demás es lo último que dijo quien lo registró.
export async function registrarOReutilizarPropietario(
  cliente: Lector,
  datos: DatosPropietario,
): Promise<number> {
  const res = await cliente.query(
    `INSERT INTO propietario (nombre, apellido, telefono, dip)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (dip) DO UPDATE
       SET nombre = EXCLUDED.nombre,
           apellido = EXCLUDED.apellido,
           telefono = EXCLUDED.telefono
     RETURNING id`,
    [datos.nombre, datos.apellido, datos.telefono, datos.dip],
  );
  return Number(res.rows[0].id);
}

// Editar los datos de un propietario ya registrado (08/10). El DIP sigue
// siendo su identidad, así que cambiarlo por el de otro propietario se
// rechaza —lo decide quien llama mirando `dipAjeno`— y el resto (nombre,
// apellido, teléfono) es lo último que dijo quien lo registró.
export async function editarPropietario(
  cliente: Lector,
  id: number,
  datos: DatosPropietario,
): Promise<boolean> {
  const res = await cliente.query(
    `UPDATE propietario
     SET nombre = $2, apellido = $3, telefono = $4, dip = $5
     WHERE id = $1`,
    [id, datos.nombre, datos.apellido, datos.telefono, datos.dip],
  );
  return (res.rowCount ?? 0) > 0;
}

// ¿Ese DIP ya es de OTRO propietario? Para no fundir dos dueños distintos en
// uno al teclear mal un documento.
export async function dipDeOtroPropietario(
  cliente: Lector,
  dip: string,
  exceptoId: number,
): Promise<string | null> {
  const res = await cliente.query(
    'SELECT nombre, apellido FROM propietario WHERE dip = $1 AND id <> $2',
    [dip, exceptoId],
  );
  if ((res.rowCount ?? 0) === 0) return null;
  return `${res.rows[0].nombre} ${res.rows[0].apellido}`.trim();
}

export interface PropietarioListado {
  id: number;
  nombre: string;
  apellido: string;
  telefono: string;
  dip: string;
}

// El dueño de un coche, para enseñarlo en la ficha del conductor.
export async function propietarioDeVehiculo(
  cliente: Lector,
  conductorId: number,
): Promise<PropietarioListado | null> {
  const res = await cliente.query(
    `SELECT p.id, p.nombre, p.apellido, p.telefono, p.dip
     FROM vehiculo v JOIN propietario p ON p.id = v.propietario_id
     WHERE v.conductor_id = $1`,
    [conductorId],
  );
  if (res.rowCount === 0) return null;
  const f = res.rows[0];
  return {
    id: Number(f.id),
    nombre: f.nombre,
    apellido: f.apellido,
    telefono: f.telefono,
    dip: f.dip,
  };
}
