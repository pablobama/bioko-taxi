// La línea que dice, sin red, de cuándo son los datos que se ven y cuánto
// falta por enviar (migración 057). La usan el taxista y el pasajero.

import type { crearT } from './i18n';
import { horaCorta } from './sinRed';

export default function AvisoSinRed({
  sinRed, t,
}: {
  sinRed: { datosDe: string | null; pendientes: number } | null;
  t: ReturnType<typeof crearT>;
}) {
  if (sinRed === null) return null;
  const partes: string[] = [];
  if (sinRed.datosDe !== null) partes.push(t('sinRed.datosDe', { hora: horaCorta(sinRed.datosDe) }));
  if (sinRed.pendientes > 0) partes.push(t('sinRed.pendientes', { n: sinRed.pendientes }));
  if (partes.length === 0) return null;
  return <p className="aviso-sin-red" role="status">{partes.join(' · ')}</p>;
}
