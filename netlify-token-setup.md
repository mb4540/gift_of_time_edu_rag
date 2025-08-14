# Netlify Token Setup for Blobs

## Problem
Netlify Functions need explicit `siteID` and `token` to access Netlify Blobs in production.

## Solution Steps

### 1. Create Personal Access Token
1. Go to [Netlify User Settings](https://app.netlify.com/user/applications#personal-access-tokens)
2. Click "New access token"
3. Give it a name like "Gift of Time Blobs Access"
4. Copy the generated token (save it securely)

### 2. Set Environment Variable
Run this command with your actual token:
```bash
netlify env:set NETLIFY_TOKEN "your_actual_token_here"
```

### 3. Verify Environment Variables
Check that both variables are set:
```bash
netlify env:list
```

You should see:
- `NETLIFY_SITE_ID=88476d1e-df1f-4215-93fc-49e736b65d4e`
- `NETLIFY_TOKEN=your_token_here`

### 4. Deploy with Updated Function
After setting the token, deploy:
```bash
netlify deploy --prod
```

## Current Status
- ✅ Site ID is set: `88476d1e-df1f-4215-93fc-49e736b65d4e`
- ❌ Token needs to be created and set
- ✅ Upload function updated to use explicit siteID and token
- ✅ Fallback logic for automatic configuration

## Expected Result
Once the token is set, the upload function will use explicit Netlify Blobs configuration and file uploads should work properly in production.
