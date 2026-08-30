FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts: los paquetes @meshtastic/* traen un preinstall "npx only-allow pnpm"
# (para bloquear instalaciones con npm/yarn en SU propio monorepo) que no aplica al
# instalarlos como dependencia con npm aquí, y que además puede fallar sin red de salida
# al registro de npm dentro del contenedor. No hay ningún otro postinstall real que
# ejecutar (comprobado contra el lockfile), así que es seguro omitir todos los scripts.
RUN npm ci --ignore-scripts

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev"]
