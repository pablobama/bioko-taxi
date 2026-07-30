// El número de teléfono como clave de identidad.
//
// Un número escrito «+240 222 41 09 86», «222410986» y «00240222410986» es la
// MISMA persona, y hasta ahora eran tres claves distintas. Con el teléfono
// como clave natural del conductor —que ya lo era, con UNIQUE incluido— eso
// significaba que el mismo taxista podía tener dos fichas, cada una con su
// monedero y su reputación, según cómo hubiera teclado su número ese día.
//
// Guinea Ecuatorial: prefijo 240 y nueve dígitos locales. Se guarda siempre
// en la forma canónica «+240XXXXXXXXX» para que la comparación sea un
// igual-a-igual y no una heurística repartida por media docena de consultas.

// La regla, dicha sin ambigüedad porque tiene un caso que decide a ciegas:
//   - Nueve dígitos → se asume local y se le pone +240. Es la apuesta correcta
//     en una aplicación que se usa en Malabo, pero es una APUESTA: un móvil
//     español también tiene nueve dígitos, y acabaría guardado como guineano.
//     Quien tenga un número de fuera debe escribir su prefijo (+34…), y
//     entonces se respeta.
//   - Cualquier otra longitud → se conserva tal cual con «+», sin inventarle
//     un prefijo. Es raro pero pasa —un cooperante, un visitante— y mutilarlo
//     sería peor que guardarlo largo.
const DIGITOS_LOCALES = 9;
const PREFIJO_GQ = '240';

// Lo mínimo para que un número sea un número. Deliberadamente permisivo, como
// la validación que ya había en la API: aquí no se juzga si la línea existe,
// solo si esto puede ser un teléfono.
const MINIMO_DIGITOS = 6;
const MAXIMO_DIGITOS = 15; // E.164

// Devuelve la forma canónica, o null si no puede ser un teléfono. Null no es
// «error»: el teléfono del pasajero es opcional (puede dar solo correo), así
// que quien llama decide si la ausencia es un problema.
export function normalizarTelefono(crudo: string | null | undefined): string | null {
  if (!crudo) return null;
  let digitos = crudo.replace(/[^0-9]/g, '');
  // Prefijo internacional escrito como 00.
  if (digitos.startsWith('00')) digitos = digitos.slice(2);
  if (digitos.length < MINIMO_DIGITOS || digitos.length > MAXIMO_DIGITOS) return null;

  // Local de Guinea Ecuatorial, con o sin prefijo de país.
  if (digitos.length === DIGITOS_LOCALES) {
    return `+${PREFIJO_GQ}${digitos}`;
  }
  if (digitos.startsWith(PREFIJO_GQ) && digitos.length === PREFIJO_GQ.length + DIGITOS_LOCALES) {
    return `+${digitos}`;
  }
  // De fuera: se respeta lo que hay.
  return `+${digitos}`;
}

// Para mensajes de error y pantallas: el número tal como se lee de viva voz.
// «+240222410986» → «222 41 09 86».
export function telefonoLegible(canonico: string): string {
  const digitos = canonico.replace(/[^0-9]/g, '');
  if (!digitos.startsWith(PREFIJO_GQ) || digitos.length !== PREFIJO_GQ.length + DIGITOS_LOCALES) {
    return canonico;
  }
  const local = digitos.slice(PREFIJO_GQ.length);
  return `${local.slice(0, 3)} ${local.slice(3, 5)} ${local.slice(5, 7)} ${local.slice(7)}`;
}
