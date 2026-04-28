# Specification: Remote Access via Cloudflare Tunnel

## Objective
Enable secure, remote access to the Deedee dashboard and API from anywhere using a custom domain (`<your-domain.com>`) without exposing ports on the local network router. Ensure the system remains secure using Cloudflare's Zero Trust ecosystem.

## Architecture

The system will use **Cloudflared**, a lightweight daemon that creates an outbound, encrypted connection to the Cloudflare edge.

1. **Cloudflare Edge**: Receives external traffic for `<your-domain.com>`.
2. **Cloudflare Tunnel (Outbound)**: The `cloudflared` container running on the Raspberry Pi maintains a persistent connection to Cloudflare.
3. **Internal Routing**: 
   - Traffic matching `<your-domain.com>/socket.io/*` -> `http://api:3001`
   - Traffic matching `<your-domain.com>/*` -> `http://web:3000`

## Implementation Steps

### Phase 1: User Manual Setup (Cloudflare Dashboard)
1. Add `<your-domain.com>` to a free Cloudflare account.
2. Delegate Nameservers (DNS) at Nic.ar to point to Cloudflare.
3. Navigate to **Cloudflare Zero Trust > Networks > Tunnels**.
4. Create a new Tunnel (e.g., "Deedee-Pi") and obtain the **Tunnel Token**.
5. Configure Public Hostnames in the Tunnel settings:
   - Subdomain empty, Domain `<your-domain.com>`, Path empty -> Service `http://web:3000`
   - Subdomain `api`, Domain `<your-domain.com>`, Path empty -> Service `http://api:3001`
     *(Note: We use a subdomain for the socket instead of a path like `/socket.io` because Cloudflare natively strips path prefixes, which causes the API WebSocket proxy to drop the connection).*

### Phase 2: System Configuration (Codebase)
1. In `docker-compose.yml`, add the `cloudflared` service.
2. Inject the `TUNNEL_TOKEN` (via `.env` or as a direct environment variable).
3. Ensure `useSocket.js` in the Web service continues to use relative origin falling back to standard ports (handled by PR previously, but verify).

### Phase 3: Security Hardening (Cloudflare Access)
1. Enable a Cloudflare Access Application for `<your-domain.com>`.
2. Set up policies (e.g., Allow only specific email addresses via PIN or Google Auth).
3. The API and Web services remain completely hidden from the public internet.

## Rollback Plan
Remove the `cloudflared` service from `docker-compose.yml`. The system falls back to the default local-only IP access mode.
