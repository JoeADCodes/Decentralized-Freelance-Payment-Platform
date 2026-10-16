FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

# Contract addresses are baked in at build time (Vite inlines VITE_* vars).
#
# VITE_API_URL defaults to empty, which makes the app call the API on its own
# origin (`/api/...`). That is what makes the nginx `/api/` proxy below the real
# path to the backend in a container: the browser talks to nginx, nginx forwards
# to `backend:3000` over the compose network, and `backend` is not resolvable
# from the browser at all (issue #55).
ARG VITE_NETWORK=testnet
ARG VITE_API_URL=
ARG VITE_ESCROW_CONTRACT_ID=
ARG VITE_DISPUTE_CONTRACT_ID=
ARG VITE_REPUTATION_CONTRACT_ID=
ARG VITE_USDC_CONTRACT_ID=
ENV VITE_NETWORK=$VITE_NETWORK \
    VITE_API_URL=$VITE_API_URL \
    VITE_ESCROW_CONTRACT_ID=$VITE_ESCROW_CONTRACT_ID \
    VITE_DISPUTE_CONTRACT_ID=$VITE_DISPUTE_CONTRACT_ID \
    VITE_REPUTATION_CONTRACT_ID=$VITE_REPUTATION_CONTRACT_ID \
    VITE_USDC_CONTRACT_ID=$VITE_USDC_CONTRACT_ID

RUN npm run build

# Unprivileged nginx (runs as `nginx`, uid 101): pid file and temp paths live
# under /tmp and the master process never holds root, so a bug in a request
# path is contained to an unprivileged user (CIS 4.1). It listens on 8080
# because a non-root process cannot bind port 80 — see nginx.conf and the
# port mapping in docker-compose.yml.
FROM nginxinc/nginx-unprivileged:alpine
COPY --from=builder --chown=nginx:nginx /app/dist /usr/share/nginx/html
# Serves the SPA *and* reverse-proxies /api/ to the backend service — the only
# way the containerised browser app reaches the API (see nginx.conf).
COPY --chown=nginx:nginx nginx.conf /etc/nginx/conf.d/default.conf
# Stated explicitly (not just inherited from the base image) so the intent is
# visible — and testable — right here.
USER nginx
EXPOSE 8080
