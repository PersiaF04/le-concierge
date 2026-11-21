#!/usr/bin/env node

/**
 * Le Concierge Server
 * 
 * Main entry point for the backend API server.
 * Handles resident management, visit tracking, and real-time updates.
 */

import express from 'express';
import WebSocket from 'ws';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Configuration
// ============================================================================

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Check for required environment variables
if (!process.env.MISTRAL_API_KEY && NODE_ENV !== 'test') {
  console.warn('⚠️  MISTRAL_API_KEY environment variable is not set');
  console.warn('    Some features will not work without it');
}

// ============================================================================
// Express App
// ============================================================================

const app = express();
const server = createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS middleware for development
if (NODE_ENV === 'development') {
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  });
}

// ============================================================================
// Health Check
// ============================================================================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '0.1.0',
    node: process.version,
    env: NODE_ENV
  });
});

// ============================================================================
// API Endpoints (Placeholders)
// ============================================================================

// POST /residents - Register a new resident
app.post('/residents', (req, res) => {
  // TODO: Implement resident registration
  res.status(501).json({ error: 'Not implemented yet' });
});

// POST /residents/:id/confirm - Resident confirms "that was me"
app.post('/residents/:id/confirm', (req, res) => {
  // TODO: Implement confirmation
  res.status(501).json({ error: 'Not implemented yet' });
});

// GET /events?flat= - Get events for a specific flat
app.get('/events', (req, res) => {
  // TODO: Implement event retrieval
  const flat = req.query.flat;
  res.status(501).json({ error: 'Not implemented yet', flat });
});

// POST /visits/:id/decision - Approve or decline a visit
app.post('/visits/:id/decision', (req, res) => {
  // TODO: Implement decision processing
  res.status(501).json({ error: 'Not implemented yet' });
});

// GET /presence - Get real-time presence status
app.get('/presence', (req, res) => {
  // TODO: Implement presence retrieval
  res.status(501).json({ error: 'Not implemented yet' });
});

// ============================================================================
// WebSocket
// ============================================================================

wss.on('connection', (ws, req) => {
  console.log('✅ WebSocket client connected');
  
  ws.on('message', (message) => {
    console.log(`📥 WebSocket message: ${message}`);
    // TODO: Handle WebSocket messages
  });
  
  ws.on('close', () => {
    console.log('❌ WebSocket client disconnected');
  });
  
  ws.on('error', (error) => {
    console.error('⚠️  WebSocket error:', error);
  });
});

// ============================================================================
// Error Handling
// ============================================================================

app.use((err, req, res, next) => {
  console.error('⚠️  Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ============================================================================
// Start Server
// ============================================================================

server.listen(PORT, () => {
  console.log(`═══════════════════════════════════════════════════════`);
  console.log(`✅ Le Concierge server is running`);
  console.log(`📍 Environment: ${NODE_ENV}`);
  console.log(`🌐 URL: http://localhost:${PORT}`);
  console.log(`🔌 WebSocket: ws://localhost:${PORT}`);
  console.log(`═══════════════════════════════════════════════════════`);
});

export default server;
