// La brújula del teléfono: hacia dónde APUNTA, no hacia dónde se mueve.
//
// Son dos cosas distintas y hasta ahora solo se usaba una. `coords.heading` del
// GPS es rumbo de MARCHA —lo deduce del desplazamiento— así que parado no
// existe: vale null, o vale el último valor bueno, o vale basura. Girar el
// móvil en la mano sin moverse no cambia nada del GPS, y por eso el coche del
// mapa no se giraba.
//
// La brújula sí: mide el campo magnético y sabe dónde está el norte estando
// quieto. A cambio, dentro de un coche en marcha miente —carrocería, altavoces,
// el propio soporte del móvil son hierro y imanes— así que la regla es usar la
// brújula parado y el GPS en marcha. Ver `PanelConductor`.
//
// Los dos navegadores lo cuentan de forma distinta, y esa es la razón de que
// esto sea un módulo con pruebas y no cuatro líneas sueltas.

// Grados desde el norte, en el sentido de las agujas del reloj, o null si el
// evento no trae nada aprovechable.
//
//   - iOS (Safari): `webkitCompassHeading` ya viene así, hecho y derecho.
//   - Android (Chrome): `alpha` de un evento ABSOLUTO cuenta al revés —en
//     sentido contrario a las agujas— así que hay que restarlo de 360.
//
// Y en los dos hay que sumar el giro de la PANTALLA: con el móvil tumbado, el
// «arriba» de la pantalla ya no es el «arriba» del aparato, y sin corregirlo el
// coche apunta noventa grados a un lado.
export function rumboDeBrujula(
  evento: { alpha?: number | null; webkitCompassHeading?: number | null; absolute?: boolean },
  giroPantalla = 0,
): number | null {
  const iOS = evento.webkitCompassHeading;
  if (typeof iOS === 'number' && Number.isFinite(iOS)) {
    return ((iOS + giroPantalla) % 360 + 360) % 360;
  }
  // Sin `absolute` el alpha es relativo a donde estaba el móvil al empezar a
  // escuchar: no es un rumbo, es un número que parece uno. Se descarta.
  if (evento.absolute !== true) return null;
  const alpha = evento.alpha;
  if (typeof alpha !== 'number' || !Number.isFinite(alpha)) return null;
  return ((360 - alpha + giroPantalla) % 360 + 360) % 360;
}

// Cuántos grados está girada la pantalla respecto del aparato.
export function giroDePantalla(): number {
  const tipo = window.screen?.orientation?.angle;
  return typeof tipo === 'number' ? tipo : 0;
}

// En iOS hay que pedir permiso, y solo se puede pedir desde un gesto de la
// persona: si se llama al arrancar, el navegador lo niega en silencio y la
// brújula no vuelve a funcionar en toda la sesión. Por eso se engancha al
// primer toque de verdad (entrar en servicio).
export async function pedirPermisoBrujula(): Promise<boolean> {
  const clase = (window as unknown as {
    DeviceOrientationEvent?: { requestPermission?: () => Promise<string> };
  }).DeviceOrientationEvent;
  if (typeof clase?.requestPermission !== 'function') return true; // Android: sin permiso
  try {
    return (await clase.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

// Escucha la brújula. Devuelve la función para dejar de escucharla.
export function escucharBrujula(alRumbo: (grados: number) => void): () => void {
  const manejar = (e: Event) => {
    const grados = rumboDeBrujula(
      e as DeviceOrientationEvent & { webkitCompassHeading?: number },
      giroDePantalla(),
    );
    if (grados !== null) alRumbo(grados);
  };
  // `deviceorientationabsolute` es el bueno en Android; iOS solo tiene
  // `deviceorientation`, pero con `webkitCompassHeading` dentro, que ya es
  // absoluto. Se escuchan los dos y `rumboDeBrujula` descarta lo que no sirve.
  window.addEventListener('deviceorientationabsolute', manejar);
  window.addEventListener('deviceorientation', manejar);
  return () => {
    window.removeEventListener('deviceorientationabsolute', manejar);
    window.removeEventListener('deviceorientation', manejar);
  };
}
