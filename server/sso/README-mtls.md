# mTLS Setup Guide

Mutual TLS (mTLS) provides bidirectional authentication between clients and the API server. The server verifies client certificates signed by a configured CA.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `MTLS_REQUIRED` | Yes (to enable) | Set to `1` to enforce mTLS on all `/api/` routes |
| `MTLS_CA_PATH` | Yes (if required) | Path to the CA certificate (PEM) that signs client certs |
| `MTLS_CERT_PATH` | No | Path to this server's TLS certificate (for completeness) |
| `MTLS_KEY_PATH` | No | Path to this server's TLS private key (for completeness) |

## How It Works

1. Caddy terminates TLS and injects the client certificate chain via the `{tls_client_certificate_pem_leaf}` placeholder into a header (default: `X-TLS-Client-Cert-PEM`).
2. The control-surface API server reads the header and verifies the certificate against `MTLS_CA_PATH`.
3. If `MTLS_REQUIRED=1` and no valid cert is present, the request receives a `401` response.
4. If a valid cert is present, the tenant ID is extracted from `O=<tenantId>` in the subject DN and passed via the `x-mtls-tenant-id` header.

## Caddy Configuration

Add the following to the Caddyfile block for `control.techinsiderbytes.com`:

```caddy
handle /api/* {
    tls_client_cert_header X-TLS-Client-Cert-PEM
    header `X-Forwarded-Client-Cert-Der-Base64` `{tls_client_certificate_pem_leaf}`
    reverse_proxy localhost:3000
}
```

For production mTLS with client certificate verification:

```caddy
handle /api/* {
    tls_client_cert_header X-TLS-Client-Cert-PEM
    header X-Forwarded-Client-Cert-Der-Base64 {tls_client_certificate_pem_leaf}
    reverse_proxy localhost:3000
}
```

## Generating a Self-Signed CA and Client Cert

```bash
# 1. Create a CA
openssl genrsa -out ca.key 4096
openssl req -new -x509 -days 3650 -key ca.key -out ca.crt \
  -subj "/C=US/ST=CA/L=SF/O=MyOrg/CN=MyOrg CA"

# 2. Create a client key and CSR
openssl genrsa -out client.key 2048
openssl req -new -key client.key -out client.csr \
  -subj "/C=US/ST=CA/L=SF/O=mytenant/CN=client"

# 3. Sign the client cert with the CA
openssl x509 -req -days 365 -in client.csr -CA ca.crt -CAkey ca.key \
  -CAcreateserial -out client.crt

# 4. Export the full chain (cert + CA) for the client
cat client.crt ca.crt > client-chain.pem
```

Set in environment:

```bash
export MTLS_REQUIRED=1
export MTLS_CA_PATH=/path/to/ca.crt
export MTLS_CERT_PATH=/path/to/server.crt   # optional
export MTLS_KEY_PATH=/path/to/server.key    # optional
```

## Verifying

```bash
# With a client cert
curl --cert client.crt --key client.key --cacert ca.crt \
  https://control.techinsiderbytes.com/api/home

# Without a cert (should return 401 when MTLS_REQUIRED=1)
curl https://control.techinsiderbytes.com/api/home
# {"error":"client certificate required"}
```