FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM dependencies AS runtime
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts/remove-legacy-mailboxes.mjs ./scripts/remove-legacy-mailboxes.mjs
RUN mkdir -p /app/keys /app/mail-keys /app/mail-files && chown node:node /app/keys /app/mail-files && chown 65532:65532 /app/mail-keys && chmod 700 /app/mail-keys /app/mail-files
USER node
ENV HOST=0.0.0.0 PORT=3210 DATA_DIR=/app/keys MASTER_KEY_FILE=/app/keys/master.key
EXPOSE 3210
CMD ["node","src/server.js"]

FROM dependencies AS test
COPY src ./src
COPY public ./public
COPY test ./test
CMD ["npm","test"]
