#!/bin/bash

# Netlify Blobs Setup Script
# Run this after claiming the site on Netlify

echo "🔧 Setting up Netlify Blobs for Gift of Time Assistant..."

# Check if netlify CLI is installed
if ! command -v netlify &> /dev/null; then
    echo "❌ Netlify CLI not found. Please install it first:"
    echo "npm install -g netlify-cli"
    exit 1
fi

# Check if user is logged in
if ! netlify status &> /dev/null; then
    echo "❌ Please login to Netlify first:"
    echo "netlify login"
    exit 1
fi

# Link the project (you'll need to select the claimed site)
echo "🔗 Linking project to Netlify site..."
netlify link

# Create blob stores
echo "📦 Creating blob stores..."
netlify blobs:create uploads --description "File uploads storage"
netlify blobs:create extracted --description "Extracted text content"
netlify blobs:create generated --description "Generated content"
netlify blobs:create exports --description "Export files"

# Set environment variables if needed
echo "🔧 Setting up environment variables..."
netlify env:set NETLIFY_BLOBS_ENABLED true

echo "✅ Netlify Blobs setup complete!"
echo "🚀 Your site should now support file uploads properly."
echo ""
echo "Next steps:"
echo "1. Test the upload functionality at: https://gift-of-time-edu-rag.windsurf.build"
echo "2. If you need to set additional environment variables (OPENAI_API_KEY, etc.), use:"
echo "   netlify env:set OPENAI_API_KEY your_key_here"
