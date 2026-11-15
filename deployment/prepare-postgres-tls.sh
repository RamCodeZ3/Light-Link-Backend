#!/usr/bin/env bash
# Genera una CA privada, certificado de servidor para IP y cliente light_link_app.
# No conecta a ningún servidor ni imprime claves. No sobrescribe directorios.
set -euo pipefail
if [[ $# != 2 ]]; then
  echo 'Uso: bash deployment/prepare-postgres-tls.sh IP_PUBLICA DIRECTORIO_NUEVO' >&2
  exit 1
fi
tls_ip=$1
tls_dir=$2
python3 -c 'import ipaddress,sys; ipaddress.ip_address(sys.argv[1])' "$tls_ip"
if [[ -e "$tls_dir" ]]; then
  echo 'El directorio de destino ya existe; elige uno nuevo para no sobrescribir claves.' >&2
  exit 1
fi
umask 077
mkdir -p "$tls_dir/private" "$tls_dir/server" "$tls_dir/client"
tls_dir=$(cd "$tls_dir" && pwd)
openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
  -subj '/CN=Light Link Private CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$tls_dir/private/ca.key" -out "$tls_dir/ca.crt" 2>"$tls_dir/openssl.log"
openssl req -new -newkey rsa:3072 -nodes \
  -subj '/CN=light-link-postgresql' \
  -keyout "$tls_dir/server/server.key" -out "$tls_dir/private/server.csr" 2>>"$tls_dir/openssl.log"
cat > "$tls_dir/private/server.ext" <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$tls_ip
EXT
openssl x509 -req -sha256 -days 365 \
  -in "$tls_dir/private/server.csr" -CA "$tls_dir/ca.crt" \
  -CAkey "$tls_dir/private/ca.key" -set_serial "0x$(openssl rand -hex 16)" \
  -extfile "$tls_dir/private/server.ext" -out "$tls_dir/server/server.crt" 2>>"$tls_dir/openssl.log"
openssl req -new -newkey rsa:3072 -nodes \
  -subj '/CN=light_link_app' \
  -keyout "$tls_dir/client/client.key" -out "$tls_dir/private/client.csr" 2>>"$tls_dir/openssl.log"
cat > "$tls_dir/private/client.ext" <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth
EXT
openssl x509 -req -sha256 -days 365 \
  -in "$tls_dir/private/client.csr" -CA "$tls_dir/ca.crt" \
  -CAkey "$tls_dir/private/ca.key" -set_serial "0x$(openssl rand -hex 16)" \
  -extfile "$tls_dir/private/client.ext" -out "$tls_dir/client/client.crt" 2>>"$tls_dir/openssl.log"
cp "$tls_dir/ca.crt" "$tls_dir/server/ca.crt"
openssl verify -CAfile "$tls_dir/ca.crt" -purpose sslserver -verify_ip "$tls_ip" "$tls_dir/server/server.crt"
openssl verify -CAfile "$tls_dir/ca.crt" -purpose sslclient "$tls_dir/client/client.crt"
echo 'Certificados generados. Conserva private/ca.key fuera de Docker y de Vercel.'
echo 'Servidor y cliente vencen en 365 días; programa su renovación antes del vencimiento.'
