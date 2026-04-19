#!/bin/bash
# deploy.sh — One-command Cloud Run deployment for VenueAI
#
# Prerequisites:
#   gcloud CLI installed and authenticated
#   Docker installed
#   .env file with your API keys
#
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh

set -e  # Exit on any error

# ── Config ────────────────────────────────────────────────────────────────────
PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-your-gcp-project-id}"   # ← Set this
REGION="asia-south1"                                         # Mumbai
SERVICE="venue-ai"
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE}"

echo "🏟️  VenueAI — Cloud Run Deployment"
echo "   Project:  ${PROJECT_ID}"
echo "   Region:   ${REGION}"
echo "   Service:  ${SERVICE}"
echo ""

# ── Step 1: Build backend Docker image ───────────────────────────────────────
echo "🐳 Step 1/4: Building backend Docker image..."
gcloud builds submit ./backend \
  --tag "${IMAGE}-backend" \
  --project "${PROJECT_ID}"

# ── Step 2: Deploy backend to Cloud Run ──────────────────────────────────────
echo "🚀 Step 2/4: Deploying backend to Cloud Run..."
gcloud run deploy "${SERVICE}-api" \
  --image "${IMAGE}-backend" \
  --platform managed \
  --region "${REGION}" \
  --allow-unauthenticated \
  --port 8080 \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 10 \
  --set-env-vars "GEMINI_API_KEY=${GEMINI_API_KEY},FIREBASE_DATABASE_URL=${FIREBASE_DATABASE_URL},CRICAPI_KEY=${CRICAPI_KEY}" \
  --project "${PROJECT_ID}"

# ── Step 3: Get backend URL ───────────────────────────────────────────────────
BACKEND_URL=$(gcloud run services describe "${SERVICE}-api" \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --format 'value(status.url)')

echo "✅ Backend deployed: ${BACKEND_URL}"

# ── Step 4: Update frontend config with backend URL ──────────────────────────
echo "✏️  Step 3/4: Updating frontend backend URL..."
sed -i "s|const BACKEND_URL = '.*'|const BACKEND_URL = '${BACKEND_URL}'|g" gemini.js

# ── Step 5: Build frontend Docker image ─────────────────────────────────────
echo "🐳 Step 4/4: Building and deploying frontend..."
gcloud builds submit . \
  --tag "${IMAGE}-frontend" \
  --project "${PROJECT_ID}" \
  --ignore-file .gcloudignore

gcloud run deploy "${SERVICE}" \
  --image "${IMAGE}-frontend" \
  --platform managed \
  --region "${REGION}" \
  --allow-unauthenticated \
  --port 8080 \
  --project "${PROJECT_ID}"

# ── Done ──────────────────────────────────────────────────────────────────────
FRONTEND_URL=$(gcloud run services describe "${SERVICE}" \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --format 'value(status.url)')

echo ""
echo "🎉 Deployment Complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   Frontend:  ${FRONTEND_URL}"
echo "   Backend:   ${BACKEND_URL}"
echo "   Health:    ${BACKEND_URL}/health"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   Add this URL to your GitHub README and LinkedIn post!"
