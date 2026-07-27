# Multi-stage Dockerfile for Lambda deployment with Lambda Web Adapter
# Requirements: 1.1, 1.4

# Stage 1: Build stage - install production dependencies
FROM public.ecr.aws/docker/library/node:20-slim AS builder
WORKDIR /app

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm ci --only=production

# Stage 2: Production stage - minimal runtime image
FROM public.ecr.aws/docker/library/node:20-slim
WORKDIR /app

# Copy Lambda Web Adapter extension (Requirement 1.1)
# This enables traditional Express.js apps to run in Lambda
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4 /lambda-adapter /opt/extensions/lambda-adapter

# Copy production dependencies from builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy application files
COPY package*.json ./
COPY server.js ./
COPY app.js ./
COPY pitch_logic.js ./
COPY lib/ ./lib/
COPY index.html ./
COPY styles.css ./
COPY *.svg ./

# Lambda Web Adapter configuration
# PORT: Lambda Web Adapter forwards requests to this port
# AWS_LWA_READINESS_CHECK_PATH: Health check endpoint for readiness probe
# AWS_LWA_ENABLE_COMPRESSION: gzip the response body so large teamsData payloads
#   stay under the ALB 1 MB Lambda-response limit (oversized responses returned a
#   502, blocking all data loads / team + player selection).
ENV PORT=8080
ENV AWS_LWA_READINESS_CHECK_PATH=/health
ENV AWS_LWA_ENABLE_COMPRESSION=true
# Node's default heap cap is ~half the container's memory; give season-scale
# loads explicit headroom within the Lambda's 2048 MB allocation.
ENV NODE_OPTIONS=--max-old-space-size=1536

# Expose the port for local testing
EXPOSE 8080

# Start the Express server (Requirement 1.4 - Node.js 20 slim base)
CMD ["node", "server.js"]
