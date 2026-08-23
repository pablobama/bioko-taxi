// La hora de Malabo.
//
// Malabo va en UTC+1 todo el año: no hay cambio de hora. Se fija aquí y no se
// lee del reloj del servidor a propósito — el servidor está en Fráncfort y
// corre en UTC, así que su medianoche no es la de nadie que use esto—.
//
// Vive en el dominio y no en una ruta porque lo usan dos: el mapa de
// recorridos del panel del operador y las estadísticas del propio taxista. Si
// cada uno tuviera su copia, el día de uno acabaría empezando a otra hora que
// el del otro, y los dos números dirían cosas distintas del mismo turno.

const HORAS_MALABO = 1;

// Las 00:00 de Malabo de hace `dias - 1` días, en UTC. Con `dias = 1` es hoy
// desde las 00:00, no las últimas 24 horas: una pestaña que se llama «Hoy» a
// las diez de la mañana no puede estar enseñando el turno de ayer por la
// tarde, que es lo que pasaba.
export function inicioDelDiaEnMalabo(dias: number, ahora: Date): Date {
  const local = new Date(ahora.getTime() + HORAS_MALABO * 3_600_000);
  const medianocheLocal = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - (dias - 1),
  );
  return new Date(medianocheLocal - HORAS_MALABO * 3_600_000);
}
