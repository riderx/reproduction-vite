# syntax=docker/dockerfile:1
FROM cloudflare/sandbox:0.6.0

# Ports exposed here are required for wrangler dev preview URLs.
EXPOSE 3333
