// Verificación de teléfono por SMS (migración 027, revierte la decisión 3.1).
//
// Enviar y comprobar un código es una llamada síncrona petición-respuesta,
// no un evento que se pueda reintentar en segundo plano: el usuario está
// delante, esperando el código. Por eso esto NO es un Adaptador del bus de
// eventos (src/eventos/) — es un servicio que se inyecta directo en
// crearServidor, igual que el emisor o las conexiones SSE.

export interface ServicioVerificacionTelefono {
  enviarCodigo(telefono: string): Promise<void>;
  // true si el código es el que se envió a ese teléfono.
  comprobarCodigo(telefono: string, codigo: string): Promise<boolean>;
}

// Implementación real: API REST de Twilio Verify. No requiere registro A2P
// 10DLC (a diferencia de un número normal de mensajería) porque Verify está
// pensado para códigos de un solo uso.
export class ServicioVerificacionTwilio implements ServicioVerificacionTelefono {
  private readonly credenciales: string;

  constructor(
    private readonly accountSid: string | undefined = process.env.TWILIO_ACCOUNT_SID,
    private readonly authToken: string | undefined = process.env.TWILIO_AUTH_TOKEN,
    private readonly servicioSid: string | undefined = process.env.TWILIO_VERIFY_SERVICE_SID,
  ) {
    if (!accountSid || !authToken || !servicioSid) {
      throw new Error(
        'ServicioVerificacionTwilio sin configurar: definir TWILIO_ACCOUNT_SID, '
        + 'TWILIO_AUTH_TOKEN y TWILIO_VERIFY_SERVICE_SID. En desarrollo, se usa '
        + 'ServicioVerificacionConsola si faltan.',
      );
    }
    this.credenciales = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  }

  private async llamar(ruta: string, cuerpo: Record<string, string>): Promise<Record<string, unknown>> {
    const respuesta = await fetch(
      `https://verify.twilio.com/v2/Services/${this.servicioSid}/${ruta}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${this.credenciales}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(cuerpo),
      },
    );
    const datos = await respuesta.json() as Record<string, unknown>;
    if (!respuesta.ok) {
      throw new Error(`Twilio Verify respondió ${respuesta.status}: ${JSON.stringify(datos)}`);
    }
    return datos;
  }

  async enviarCodigo(telefono: string): Promise<void> {
    await this.llamar('Verifications', { To: telefono, Channel: 'sms' });
  }

  async comprobarCodigo(telefono: string, codigo: string): Promise<boolean> {
    const datos = await this.llamar('VerificationCheck', { To: telefono, Code: codigo });
    return datos.status === 'approved';
  }
}

// Desarrollo local sin credenciales de Twilio: el código se escribe en el
// log del servidor en vez de mandarse. Genera el código él mismo, porque
// aquí no hay Twilio detrás que lo haga.
export class ServicioVerificacionConsola implements ServicioVerificacionTelefono {
  private readonly codigos = new Map<string, string>();

  async enviarCodigo(telefono: string): Promise<void> {
    const codigo = String(Math.floor(100000 + Math.random() * 900000));
    this.codigos.set(telefono, codigo);
    console.log(`[verificación de teléfono] código para ${telefono}: ${codigo}`);
  }

  async comprobarCodigo(telefono: string, codigo: string): Promise<boolean> {
    return this.codigos.get(telefono) === codigo;
  }
}

// Para pruebas: igual que ServicioVerificacionConsola pero sin loguear, y
// con el último código consultable directamente (equivalente a EmisorRegistro
// para eventos de dominio).
export class ServicioVerificacionRegistro implements ServicioVerificacionTelefono {
  private readonly codigos = new Map<string, string>();
  enviados: string[] = [];

  async enviarCodigo(telefono: string): Promise<void> {
    const codigo = String(Math.floor(100000 + Math.random() * 900000));
    this.codigos.set(telefono, codigo);
    this.enviados.push(telefono);
  }

  async comprobarCodigo(telefono: string, codigo: string): Promise<boolean> {
    return this.codigos.get(telefono) === codigo;
  }

  ultimoCodigoPara(telefono: string): string | undefined {
    return this.codigos.get(telefono);
  }
}
