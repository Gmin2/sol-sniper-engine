# Use Node.js 18 Alpine as the base image
FROM node:18-alpine

# Install pnpm
RUN npm install -g pnpm

# Set the working directory
WORKDIR /app

# Copy package files first to leverage Docker cache
COPY package.json pnpm-lock.yaml ./

# Install dependencies
# --no-frozen-lockfile allows package.json changes
RUN pnpm install --no-frozen-lockfile

# Copy the rest of the application code
COPY . .

# Build the TypeScript application
RUN pnpm run build

# Expose the application port
EXPOSE 3000

# Start the application
CMD ["pnpm", "start"]