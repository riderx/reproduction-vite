# syntax=docker/dockerfile:1
FROM cloudflare/sandbox:0.5.4

# Ports exposed here are required for wrangler dev preview URLs.
EXPOSE 3333
