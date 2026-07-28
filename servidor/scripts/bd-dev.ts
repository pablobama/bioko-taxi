// Arranca un PostgreSQL 16 real para desarrollo local, sin Docker ni
// instalación con permisos de administrador. Usa los binarios del paquete
// @embedded-postgres/windows-x64 (instalado con --force: esta máquina es
// Windows ARM64 y ejecuta los binarios x64 bajo la emulación del sistema).
// En producción (VPS) se usa un PostgreSQL 16 normal.
//
// Uso: tsx scripts/bd-dev.ts   (queda en primer plano; Ctrl+C para parar)
// Conexión resultante: postgres://taxi:taxi@localhost:5433/taxi

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { initdb, postgres } from '@embedded-postgres/windows-x64';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRECTORIO_DATOS = path.join(RAIZ, '.bd-dev', 'datos');
const PUERTO = 5433;
const USUARIO = 'taxi';
const CLAVE = 'taxi';
const BASE_DATOS = 'taxi';

function ejecutar(programa: string, argumentos: string[]): Promise<void> {
  return new Promise((resolver, rechazar) => {
    const proceso = spawn(programa, argumentos, { stdio: ['ignore', 'inherit', 'inherit'] });
    proceso.on('error', rechazar);
    proceso.on('exit', (codigo) => {
      if (codigo === 0) {
        resolver();
      } else {
        rechazar(new Error(`${path.basename(programa)} terminó con código ${codigo}`));
      }
    });
  });
}

async function inicializarSiHaceFalta(): Promise<void> {
  if (existsSync(path.join(DIRECTORIO_DATOS, 'PG_VERSION'))) {
    return;
  }
  console.log('Inicializando el directorio de datos (solo la primera vez)…');
  await mkdir(path.dirname(DIRECTORIO_DATOS), { recursive: true });
  const ficheroClave = path.join(RAIZ, '.bd-dev', 'clave.tmp');
  await writeFile(ficheroClave, `${CLAVE}\n`);
  try {
    await ejecutar(initdb, [
      `--pgdata=${DIRECTORIO_DATOS}`,
      '--auth=password',
      `--username=${USUARIO}`,
      `--pwfile=${ficheroClave}`,
      '--encoding=UTF8',
      '--locale=C',
    ]);
  } finally {
    await rm(ficheroClave, { force: true });
  }
}

function arrancarServidor(): Promise<ReturnType<typeof spawn>> {
  return new Promise((resolver, rechazar) => {
    const proceso = spawn(postgres, ['-D', DIRECTORIO_DATOS, '-p', String(PUERTO)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let listo = false;
    const alRecibirSalida = (fragmento: Buffer) => {
      const texto = fragmento.toString();
      process.stderr.write(texto);
      // Los mensajes salen en inglés porque initdb se hizo con --locale=C.
      if (!listo && texto.includes('ready to accept connections')) {
        listo = true;
        resolver(proceso);
      }
    };
    proceso.stdout?.on('data', alRecibirSalida);
    proceso.stderr?.on('data', alRecibirSalida);
    proceso.on('error', rechazar);
    proceso.on('exit', (codigo) => {
      if (!listo) {
        rechazar(new Error(`postgres terminó con código ${codigo} antes de estar listo`));
      }
    });
  });
}

async function crearBaseDatosSiHaceFalta(): Promise<void> {
  const cliente = new pg.Client({
    host: 'localhost', port: PUERTO, user: USUARIO, password: CLAVE, database: 'postgres',
  });
  await cliente.connect();
  try {
    const res = await cliente.query('SELECT 1 FROM pg_database WHERE datname = $1', [BASE_DATOS]);
    if (res.rowCount === 0) {
      await cliente.query(`CREATE DATABASE ${BASE_DATOS}`);
      console.log(`Base de datos «${BASE_DATOS}» creada.`);
    }
  } finally {
    await cliente.end();
  }
}

async function principal(): Promise<void> {
  await inicializarSiHaceFalta();
  const servidor = await arrancarServidor();
  await crearBaseDatosSiHaceFalta();

  console.log(`\nPostgreSQL de desarrollo escuchando en localhost:${PUERTO}`);
  console.log(`Conexión: postgres://${USUARIO}:${CLAVE}@localhost:${PUERTO}/${BASE_DATOS}`);
  console.log('Ctrl+C para parar.');

  const parar = () => {
    console.log('\nParando PostgreSQL…');
    servidor.kill();
    process.exit(0);
  };
  process.on('SIGINT', parar);
  process.on('SIGTERM', parar);
}

principal().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
