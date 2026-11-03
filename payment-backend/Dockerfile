FROM gradle:8.10-jdk21 AS attestation-build
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch v0.4 https://github.com/android/keyattestation.git /opt/keyattestation
COPY attestation-verifier /opt/aurelia-attestation-verifier
WORKDIR /opt/aurelia-attestation-verifier
RUN gradle --no-daemon shadowJar

FROM eclipse-temurin:21-jre-jammy AS java-runtime

FROM node:22-bookworm-slim
ENV NODE_ENV=production
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="/opt/java/openjdk/bin:${PATH}"
WORKDIR /app
COPY --from=java-runtime /opt/java/openjdk /opt/java/openjdk
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
COPY --from=attestation-build /opt/aurelia-attestation-verifier/build/libs/aurelia-attestation-verifier.jar ./aurelia-attestation-verifier.jar
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 8085
CMD ["sh","-c","java -jar /app/aurelia-attestation-verifier.jar >/dev/null 2>&1 & exec node /app/src/local-server.mjs"]
