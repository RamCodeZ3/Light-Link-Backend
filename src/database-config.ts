import { createSecureContext } from 'node:tls';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import type { PoolConfig } from 'pg';
import { DatabaseStartupError } from './startup-errors.js';
type TlsEnvironment = Partial<
  Pick<NodeJS.ProcessEnv, 'DATABASE_SSL_CA' | 'DATABASE_SSL_CERT' | 'DATABASE_SSL_KEY'>
>;
const invalid = (
  code = 'DATABASE_TLS_INVALID',
  message = 'Configuración TLS de PostgreSQL inválida. Revisa DATABASE_SSL_CA, DATABASE_SSL_CERT y DATABASE_SSL_KEY.',
) => new DatabaseStartupError(code, message);
function pem(value: string) {
  return value.replace(/\\n/g, '\n').trim() + '\n';
}
/** CA privada para Vercel. Conserva validación de cadena e identidad del servidor. */
export function databaseConfig(url: string, env: TlsEnvironment = process.env): PoolConfig {
  const config: PoolConfig = {
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
    statement_timeout: 10000,
  };
  const ca = env.DATABASE_SSL_CA,
    cert = env.DATABASE_SSL_CERT,
    key = env.DATABASE_SSL_KEY;
  if (!ca && !cert && !key) return config;
  if (!ca)
    throw invalid(
      'DATABASE_TLS_CA_MISSING',
      'Falta DATABASE_SSL_CA: copia el contenido completo de ca.crt.',
    );
  if (Boolean(cert) !== Boolean(key))
    throw invalid(
      'DATABASE_TLS_CLIENT_INCOMPLETE',
      'DATABASE_SSL_CERT y DATABASE_SSL_KEY deben configurarse juntos con el contenido completo de client.crt y client.key.',
    );
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalid('DATABASE_URL_INVALID', 'DATABASE_URL no es una URL válida de PostgreSQL.');
  }
  // node-postgres puede reemplazar ssl al leer estas opciones de la URL.
  for (const name of parsed.searchParams.keys())
    if (name.toLowerCase().startsWith('ssl') || name.toLowerCase() === 'uselibpqcompat')
      throw new DatabaseStartupError(
        'DATABASE_TLS_CONFLICT',
        'Con DATABASE_SSL_CA, retira las opciones ssl de DATABASE_URL; TLS se configura mediante las variables DATABASE_SSL_*.',
      );
  const ssl = {
    ca: pem(ca),
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2' as const,
    ...(cert && key ? { cert: pem(cert), key: pem(key) } : {}),
  };
  try {
    new X509Certificate(ssl.ca);
  } catch {
    throw invalid(
      'DATABASE_TLS_CA_INVALID',
      'DATABASE_SSL_CA no contiene un certificado PEM válido. Copia ca.crt completo, incluidas las líneas BEGIN y END.',
    );
  }
  if (ssl.cert && ssl.key) {
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(ssl.cert);
    } catch {
      throw invalid(
        'DATABASE_TLS_CERT_INVALID',
        'DATABASE_SSL_CERT no contiene un certificado PEM válido. Copia client.crt completo.',
      );
    }
    let privateKey: ReturnType<typeof createPrivateKey>;
    try {
      privateKey = createPrivateKey(ssl.key);
    } catch {
      throw invalid(
        'DATABASE_TLS_KEY_INVALID',
        'DATABASE_SSL_KEY no contiene una clave privada PEM válida sin contraseña. Copia client.key completo.',
      );
    }
    if (!certificate.checkPrivateKey(privateKey))
      throw invalid(
        'DATABASE_TLS_KEY_MISMATCH',
        'DATABASE_SSL_CERT y DATABASE_SSL_KEY no corresponden al mismo par. Usa client.crt y client.key generados juntos.',
      );
  }
  try {
    createSecureContext(ssl);
  } catch {
    throw invalid();
  }
  return { ...config, ssl };
}
