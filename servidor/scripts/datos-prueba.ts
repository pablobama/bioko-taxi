// Datos de prueba del paso 1: 3 zonas, 20 referencias del gazetteer y
// 5 conductores con vehículo, dispositivo, monedero y presencia.
//
// El script es idempotente: se apoya en las claves naturales (nombre de zona,
// nombre de referencia, teléfono, matrícula, uuid, clave_idempotencia) y puede
// ejecutarse tantas veces como haga falta sin duplicar nada.
//
// Las coordenadas son aproximadas y los alias imitan cómo se pide de palabra;
// el catálogo real de Malabo es trabajo de campo y se cargará con la
// herramienta de administración del paso 4.
//
// Uso: tsx scripts/datos-prueba.ts

import pg from 'pg';
import { urlBaseDatos } from '../src/bd/migrar.js';

interface ZonaSemilla {
  nombre: string;
  lat: number;
  lng: number;
}

interface ReferenciaSemilla {
  zona: string;
  nombre: string;
  alias: string[];
  lat: number;
  lng: number;
}

interface ConductorSemilla {
  telefono: string;
  nombre: string;
  matricula: string;
  marca: string;
  color: string;
  uuidDispositivo: string;
  // Estado inicial de presencia para poder probar el despacho del paso 5.
  zonaPresencia: string | null; // null = DESCONECTADO
  saldoInicialXaf: number;
  // Suscripción vigente (modelo de la migración 011): sin ella no se reciben
  // broadcasts aunque haya presencia y saldo.
  suscrito: boolean;
}

const ZONAS: ZonaSemilla[] = [
  { nombre: 'Malabo Centro', lat: 3.7523, lng: 8.7741 },
  { nombre: 'Ela Nguema', lat: 3.75, lng: 8.79 },
  { nombre: 'Semu', lat: 3.758, lng: 8.766 },
];

// Adyacencia en ambos sentidos. Semu y Ela Nguema no son adyacentes entre sí
// a propósito: da un caso de prueba para la oleada 3.
const ADYACENCIAS: Array<[string, string]> = [
  ['Malabo Centro', 'Ela Nguema'],
  ['Malabo Centro', 'Semu'],
];

const REFERENCIAS: ReferenciaSemilla[] = [
  { zona: 'Malabo Centro', nombre: 'Mercado Central', alias: ['el mercado', 'mercado de Malabo'], lat: 3.7531, lng: 8.7752 },
  { zona: 'Malabo Centro', nombre: 'Catedral de Santa Isabel', alias: ['la catedral'], lat: 3.7539, lng: 8.7737 },
  { zona: 'Malabo Centro', nombre: 'Plaza de la Independencia', alias: ['la plaza', 'plaza del ayuntamiento'], lat: 3.754, lng: 8.7743 },
  { zona: 'Malabo Centro', nombre: 'Ayuntamiento de Malabo', alias: ['el ayuntamiento'], lat: 3.7542, lng: 8.7746 },
  { zona: 'Malabo Centro', nombre: 'Puerto de Malabo', alias: ['el puerto'], lat: 3.7565, lng: 8.7802 },
  { zona: 'Malabo Centro', nombre: 'Hospital General de Malabo', alias: ['el hospital', 'hospital general'], lat: 3.7508, lng: 8.7711 },
  { zona: 'Malabo Centro', nombre: 'Paseo Marítimo', alias: ['el paseo'], lat: 3.7551, lng: 8.7769 },
  { zona: 'Malabo Centro', nombre: 'Instituto Rey Malabo', alias: ['el instituto', 'rey malabo'], lat: 3.7512, lng: 8.7729 },
  { zona: 'Ela Nguema', nombre: 'Mercado de Ela Nguema', alias: ['mercado nuevo', 'mercado de nguema'], lat: 3.7496, lng: 8.7912 },
  { zona: 'Ela Nguema', nombre: 'Iglesia de Ela Nguema', alias: ['la iglesia de nguema'], lat: 3.7503, lng: 8.7895 },
  { zona: 'Ela Nguema', nombre: 'Gasolinera Total de Ela Nguema', alias: ['total nguema', 'la gasolinera'], lat: 3.749, lng: 8.7888 },
  { zona: 'Ela Nguema', nombre: 'Campo de fútbol de Ela Nguema', alias: ['el campo'], lat: 3.7485, lng: 8.7921 },
  { zona: 'Ela Nguema', nombre: 'Colegio La Salle', alias: ['la salle'], lat: 3.7511, lng: 8.7907 },
  { zona: 'Ela Nguema', nombre: 'Rotonda de Ela Nguema', alias: ['la rotonda'], lat: 3.7498, lng: 8.7879 },
  { zona: 'Semu', nombre: 'Mercado SEMU', alias: ['semu', 'mercado semu'], lat: 3.7584, lng: 8.7655 },
  { zona: 'Semu', nombre: 'Estadio de Malabo', alias: ['el estadio'], lat: 3.7591, lng: 8.7628 },
  { zona: 'Semu', nombre: 'Gasolinera SEMU', alias: ['gasolinera de semu'], lat: 3.7576, lng: 8.7671 },
  { zona: 'Semu', nombre: 'Farmacia de Semu', alias: ['la farmacia'], lat: 3.7579, lng: 8.7663 },
  { zona: 'Semu', nombre: 'Iglesia Bautista de Semu', alias: ['la bautista'], lat: 3.7588, lng: 8.7648 },
  { zona: 'Semu', nombre: 'Escuela Nacional de Semu', alias: ['la escuela'], lat: 3.7571, lng: 8.7659 },
];

const CONDUCTORES: ConductorSemilla[] = [
  {
    telefono: '+240222100001', nombre: 'Julián Obiang', matricula: 'GE-1042-B',
    marca: 'Toyota Corolla', color: 'blanco',
    uuidDispositivo: '00000000-0000-4000-8000-000000000001',
    zonaPresencia: 'Malabo Centro', saldoInicialXaf: 2000, suscrito: true,
  },
  {
    telefono: '+240222100002', nombre: 'María Nchama', matricula: 'GE-2317-A',
    marca: 'Hyundai Accent', color: 'azul',
    uuidDispositivo: '00000000-0000-4000-8000-000000000002',
    zonaPresencia: 'Malabo Centro', saldoInicialXaf: 2000, suscrito: true,
  },
  {
    telefono: '+240222100003', nombre: 'Pedro Esono', matricula: 'GE-3588-B',
    marca: 'Toyota Yaris', color: 'gris',
    uuidDispositivo: '00000000-0000-4000-8000-000000000003',
    zonaPresencia: 'Ela Nguema', saldoInicialXaf: 1500, suscrito: true,
  },
  {
    telefono: '+240222100004', nombre: 'Rosa Bindang', matricula: 'GE-4761-A',
    marca: 'Kia Rio', color: 'rojo',
    uuidDispositivo: '00000000-0000-4000-8000-000000000004',
    zonaPresencia: null, saldoInicialXaf: 500, suscrito: false,
  },
  {
    telefono: '+240222100005', nombre: 'Francisco Edú', matricula: 'GE-5029-B',
    marca: 'Toyota Corolla', color: 'negro',
    uuidDispositivo: '00000000-0000-4000-8000-000000000005',
    // Sin suscripción: caso de prueba del bloqueo de emisión (migración
    // 011), aunque esté conectado y con presencia viva.
    zonaPresencia: 'Semu', saldoInicialXaf: 0, suscrito: false,
  },
];

async function principal(): Promise<void> {
  const cliente = new pg.Client({ connectionString: urlBaseDatos() });
  await cliente.connect();
  try {
    await cliente.query('BEGIN');

    // --- Zonas ---
    const idZona = new Map<string, number>();
    for (const zona of ZONAS) {
      await cliente.query(
        `INSERT INTO zona (nombre, centroide_lat, centroide_lng)
         VALUES ($1, $2, $3) ON CONFLICT (nombre) DO NOTHING`,
        [zona.nombre, zona.lat, zona.lng],
      );
      const res = await cliente.query('SELECT id FROM zona WHERE nombre = $1', [zona.nombre]);
      idZona.set(zona.nombre, res.rows[0].id);
    }

    for (const [a, b] of ADYACENCIAS) {
      await cliente.query(
        `INSERT INTO zona_adyacencia (zona_id, zona_adyacente_id)
         VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING`,
        [idZona.get(a), idZona.get(b)],
      );
    }

    // --- Referencias y alias ---
    for (const ref of REFERENCIAS) {
      await cliente.query(
        `INSERT INTO referencia (zona_id, nombre, lat, lng)
         VALUES ($1, $2, $3, $4) ON CONFLICT (zona_id, nombre) DO NOTHING`,
        [idZona.get(ref.zona), ref.nombre, ref.lat, ref.lng],
      );
      const res = await cliente.query(
        'SELECT id FROM referencia WHERE zona_id = $1 AND nombre = $2',
        [idZona.get(ref.zona), ref.nombre],
      );
      const referenciaId: number = res.rows[0].id;
      for (const alias of ref.alias) {
        await cliente.query(
          `INSERT INTO referencia_alias (referencia_id, alias)
           VALUES ($1, $2) ON CONFLICT (referencia_id, alias) DO NOTHING`,
          [referenciaId, alias],
        );
      }
    }

    // --- Conductores: vehículo, dispositivo, monedero, presencia ---
    for (const c of CONDUCTORES) {
      await cliente.query(
        `INSERT INTO conductor (telefono, nombre, estado_verificacion)
         VALUES ($1, $2, 'verificado') ON CONFLICT (telefono) DO NOTHING`,
        [c.telefono, c.nombre],
      );
      const res = await cliente.query('SELECT id FROM conductor WHERE telefono = $1', [c.telefono]);
      const conductorId: number = res.rows[0].id;

      await cliente.query(
        // plazas: 4 por defecto (taxi compartido, migración 013).
        `INSERT INTO vehiculo (conductor_id, matricula, marca, color)
         VALUES ($1, $2, $3, $4) ON CONFLICT (matricula) DO NOTHING`,
        [conductorId, c.matricula, c.marca, c.color],
      );

      await cliente.query(
        `INSERT INTO dispositivo (uuid_persistente, tipo, conductor_id, fcm_token, ultimo_heartbeat)
         VALUES ($1, 'conductor', $2, $3, now())
         ON CONFLICT (uuid_persistente) DO NOTHING`,
        [c.uuidDispositivo, conductorId, `token-fcm-prueba-${c.telefono}`],
      );

      await cliente.query(
        `INSERT INTO monedero (conductor_id) VALUES ($1) ON CONFLICT (conductor_id) DO NOTHING`,
        [conductorId],
      );
      if (c.saldoInicialXaf > 0) {
        await cliente.query(
          `INSERT INTO apunte (monedero_id, tipo, importe_xaf, clave_idempotencia)
           SELECT m.id, 'recarga', $2, $3 FROM monedero m WHERE m.conductor_id = $1
           ON CONFLICT (clave_idempotencia) DO NOTHING`,
          [conductorId, c.saldoInicialXaf, `semilla-recarga-inicial-${c.telefono}`],
        );
      }

      const disponible = c.zonaPresencia !== null;
      await cliente.query(
        `INSERT INTO presencia (conductor_id, zona_id, estado, ultimo_heartbeat)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (conductor_id) DO UPDATE
           SET zona_id = EXCLUDED.zona_id,
               estado = EXCLUDED.estado,
               ultimo_heartbeat = EXCLUDED.ultimo_heartbeat,
               actualizada_en = now()`,
        [
          conductorId,
          disponible ? idZona.get(c.zonaPresencia!) : null,
          disponible ? 'DISPONIBLE' : 'DESCONECTADO',
          disponible ? new Date() : null,
        ],
      );

      // Suscripción (migración 011): vigente 7 días para los suscritos;
      // explícitamente NULL para los no suscritos (idempotente).
      await cliente.query(
        `UPDATE conductor
         SET suscrito_hasta = CASE WHEN $2 THEN now() + interval '7 days' ELSE NULL END
         WHERE id = $1`,
        [conductorId, c.suscrito],
      );
    }

    await cliente.query('COMMIT');
  } catch (error) {
    await cliente.query('ROLLBACK');
    throw error;
  } finally {
    await cliente.end();
  }

  console.log('Datos de prueba cargados: 3 zonas, 20 referencias, 5 conductores.');
}

principal().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
