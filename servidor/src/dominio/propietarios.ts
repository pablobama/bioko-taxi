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
