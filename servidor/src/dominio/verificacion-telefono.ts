// Verificación de teléfono por SMS (migración 027, revierte la decisión 3.1).
//
// Enviar y comprobar un código es una llamada síncrona petición-respuesta,
// no un evento que se pueda reintentar en segundo plano: el usuario está
// delante, esperando el código. Por eso esto NO es un Adaptador del bus de
// eventos (src/eventos/) — es un servicio que se inyecta directo en
// crearServidor, igual que el emisor o las conexiones SSE.

// Por dónde llega el código. El SMS es lo normal; la LLAMADA existe porque en
// Malabo el SMS a veces no llega: GETESA (Orange) descarta mensajes de remitente
// alfanumérico internacional —Twilio los devuelve como «undelivered 30008»— y
// quien se queda fuera se queda fuera del todo. Una llamada entra por otra
// puerta de la red y no depende de ese filtro.
export type CanalDeCodigo = 'sms' | 'llamada';

export interface ServicioVerificacionTelefono {
  enviarCodigo(telefono: string, canal?: CanalDeCodigo): Promise<void>;
  // true si el código es el que se envió a ese teléfono.
  comprobarCodigo(telefono: string, codigo: string): Promise<boolean>;
}

// Lo que ve la persona cuando Twilio falla: corto, en su sitio y con el único
// dato que le sirve — el número que tiene que dictarle al operador para que
// alguien busque qué pasó. «De avería» a propósito: si dijera solo «este
// código», más de uno intentaría escribir 60223 en la casilla del código.
export class ErrorDeTwilio extends Error {
  statusCode = 502;

  constructor(public readonly codigoTwilio: number) {
    super(
      'No se ha podido mandar el código. Contacta con el operador y dile este '
      + `número de avería: ${codigoTwilio}.`,
    );
  }
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
      // El detalle entero, AL LOG y no a la persona. El mensaje de este error
      // viajaba tal cual hasta la pantalla —el manejador de la API reenvía
      // `message`— y quien no podía entrar se encontraba con «delivery
      // channel disabled code 60223»: las tripas de Twilio en inglés, que no
      // le dicen qué hacer y sí le enseñan con qué está hecha la plataforma.
      console.error(`Twilio Verify respondió ${respuesta.status}: ${JSON.stringify(datos)}`);
      throw new ErrorDeTwilio(
        typeof datos.code === 'number' ? datos.code : respuesta.status,
      );
    }
    return datos;
  }

  async enviarCodigo(telefono: string, canal: CanalDeCodigo = 'sms'): Promise<void> {
    await this.llamar('Verifications', {
      To: telefono,
      Channel: canal === 'llamada' ? 'call' : 'sms',
      // En español, que es la lengua de Malabo. Iba en inglés —el que Twilio
      // pone por defecto— y en una llamada eso importa mucho más que en un
      // SMS: el código lo dice una voz, y hay que entenderla a la primera.
      Locale: 'es',
    });
  }

  async comprobarCodigo(telefono: string, codigo: string): Promise<boolean> {
    try {
      const datos = await this.llamar('VerificationCheck', { To: telefono, Code: codigo });
      return datos.status === 'approved';
    } catch (error) {
      // 20404: la verificación ya no existe — caducó, o se acertó antes. Para
      // quien teclea, eso ES un código que no vale, no una avería: se le dice
      // «código incorrecto» y pide otro, en vez de mandarle al operador con
      // un número de avería por algo que se arregla solo.
      if (error instanceof ErrorDeTwilio && error.codigoTwilio === 20404) {
        return false;
      }
      throw error;
    }
  }
}

// Desarrollo local sin credenciales de Twilio: el código se escribe en el
// log del servidor en vez de mandarse. Genera el código él mismo, porque
// aquí no hay Twilio detrás que lo haga.
export class ServicioVerificacionConsola implements ServicioVerificacionTelefono {
  private readonly codigos = new Map<string, string>();

  async enviarCodigo(telefono: string, canal: CanalDeCodigo = 'sms'): Promise<void> {
    const codigo = String(Math.floor(100000 + Math.random() * 900000));
    this.codigos.set(telefono, codigo);
    console.log(`[verificación de teléfono] código para ${telefono} por ${canal}: ${codigo}`);
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
  // Por dónde se mandó cada uno. Separado de `enviados` para no tocar las
  // pruebas que ya miraban esa lista.
  canales: Array<{ telefono: string; canal: CanalDeCodigo }> = [];

  async enviarCodigo(telefono: string, canal: CanalDeCodigo = 'sms'): Promise<void> {
    const codigo = String(Math.floor(100000 + Math.random() * 900000));
    this.codigos.set(telefono, codigo);
    this.enviados.push(telefono);
    this.canales.push({ telefono, canal });
  }

  async comprobarCodigo(telefono: string, codigo: string): Promise<boolean> {
    return this.codigos.get(telefono) === codigo;
  }

  ultimoCodigoPara(telefono: string): string | undefined {
    return this.codigos.get(telefono);
  }
}
