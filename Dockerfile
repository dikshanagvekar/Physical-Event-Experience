FROM nginx:alpine

# Remove default nginx config that listens on port 80
RUN rm /etc/nginx/conf.d/default.conf

# Add our custom config that listens on port 8080 (Cloud Run requirement)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy frontend files
COPY . /usr/share/nginx/html

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
