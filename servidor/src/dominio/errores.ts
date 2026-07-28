// Errores de dominio. Toda transición rechazada lo es con un error explícito
// que dice qué se intentó y qué estaba permitido (sección 5.2).

export interface TransicionPermitida {
  estado_destino: string;
  actor: string;
}

export class ErrorTransicionInvalida extends Error {
  constructor(
    readonly ambito: 'solicitud' | 'conductor',
    readonly estadoOrigen: string | null,
    readonly estadoDestino: string,
    readonly actor: string,
    permitidas: TransicionPermitida[],
  ) {
    const desde = estadoOrigen ?? '(creación)';
    const lista = permitidas.length > 0
      ? permitidas.map((p) => `${p.estado_destino} por ${p.actor}`).join(', ')
      : 'ninguna';
    super(
      `Transición inválida en ámbito «${ambito}»: ${desde} → ${estadoDestino} `
      + `por actor «${actor}». Permitidas desde ${desde}: ${lista}.`,
    );
    this.name = 'ErrorTransicionInvalida';
  }
}

export class ErrorSaldoInsuficiente extends Error {
  constructor(
    readonly conductorId: number,
    readonly importeXaf: number,
    readonly saldoXaf: number,
  ) {
    super(
      `Cobro rechazado: un apunte de ${importeXaf} XAF dejaría el monedero del `
      + `conductor ${conductorId} en ${saldoXaf + importeXaf} XAF. `
      + `El monedero jamás queda negativo (R5).`,
    );
    this.name = 'ErrorSaldoInsuficiente';
  }
}

// Rechazo de una operación sobre una oferta: sin oferta, fuera de ventana,
// solicitud ya resuelta… El mensaje siempre dice el porqué (R2).
export class ErrorOfertaInvalida extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorOfertaInvalida';
  }
}

export class ErrorEntidadInexistente extends Error {
  constructor(entidad: string, id: number | string) {
    super(`No existe ${entidad} con identificador ${id}.`);
    this.name = 'ErrorEntidadInexistente';
  }
}
