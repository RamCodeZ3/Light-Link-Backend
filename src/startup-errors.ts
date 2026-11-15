/** Diagnósticos públicos de arranque; nunca incluyen URLs ni credenciales. */
export class RedisStartupError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RedisStartupError';
  }
}
export class DatabaseStartupError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DatabaseStartupError';
  }
}
export function startupReport(error: unknown) {
  if (error instanceof RedisStartupError || error instanceof DatabaseStartupError)
    return { event: 'startup_failed', code: error.code, message: error.message };
  const code = (error as { code?: unknown })?.code;
  const messages: Record<string, string> = {
    EADDRINUSE: 'El puerto configurado ya está ocupado.',
    EACCES: 'Sin permisos para abrir el puerto configurado.',
    ENOTFOUND: 'No se pudo resolver HOST. En el contenedor usa HOST=0.0.0.0.',
    ERR_SOCKET_BAD_PORT: 'PORT debe ser un puerto válido entre 1 y 65535.',
  };
  if (typeof code === 'string' && messages[code])
    return { event: 'startup_failed', code, message: messages[code] };
  return {
    event: 'startup_failed',
    code: 'APPLICATION_STARTUP_FAILED',
    message:
      'No se pudo iniciar la aplicación. Revisa los archivos data/sites, HOST y PORT del despliegue.',
  };
}
