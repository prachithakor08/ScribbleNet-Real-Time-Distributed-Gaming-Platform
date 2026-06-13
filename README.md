# 🎨 ScribbleNet - Real-Time Distributed Multiplayer Drawing Game

## Overview

ScribbleNet is a real-time multiplayer drawing and guessing game developed as a Distributed Systems project. The application allows multiple players to join a shared game room, draw on a synchronized canvas, and guess words through live chat communication.

The system uses WebSockets for real-time communication between clients and the server, ensuring synchronized gameplay and collaborative interactions among connected players.

---

## Features

### Multiplayer Room System

* Create private game rooms
* Join rooms using a 4-character room code
* Support for multiple players in a room
* Real-time player join and leave updates
* Host-controlled game start

### Real-Time Drawing Canvas

* Shared synchronized canvas
* Multiple color options
* Different brush sizes
* Eraser tool
* Fill bucket tool
* Undo functionality
* Clear canvas functionality

### Live Chat and Guessing

* Real-time chat communication
* Word guessing through chat
* Automatic correct answer detection
* Guess notifications

### Scoring System

* Time-based score calculation
* Drawer reward points
* Live score updates
* Final leaderboard display

### AI Integration

* Anthropic Claude API integration
* AI-generated drawing words
* AI-generated hints
* Fallback word bank when API is unavailable

### Gameplay Features

* Multiple rounds
* Configurable drawing time
* Random drawer rotation
* Progressive letter reveal system
* Hint generation during gameplay

---

## Distributed Systems Concepts Implemented

### 1. Message Passing

The application uses WebSocket-based message passing for communication between clients and the server.

Examples:

* Drawing events
* Chat messages
* Guess submissions
* Timer updates
* Game state updates

### 2. Centralized Coordination

The server acts as a central coordinator responsible for:

* Room management
* Game state management
* Score tracking
* Timer synchronization
* Event broadcasting

### 3. State Synchronization

The server maintains a consistent room state containing:

* Player information
* Scores
* Current drawer
* Active word
* Drawing history
* Game phase

### 4. Leader Rotation

The drawer role rotates among players after each turn, ensuring fair participation throughout the game.

### 5. Broadcast and Unicast Communication

Broadcast:

* Drawing updates
* Chat messages
* Timer updates
* Score updates

Unicast:

* Word choices sent only to the current drawer
* Player-specific game information

### 6. Fault Tolerance

* Handles player disconnections
* Automatically updates room state
* Skips disconnected drawers
* Cleans up empty rooms

---

## Technology Stack

### Frontend

* HTML5
* CSS3
* JavaScript
* Canvas API

### Backend

* Node.js
* Express.js
* WebSocket (ws)

### AI Services

* Anthropic Claude API

### Utilities

* UUID
* Ngrok

---

## Project Structure

```text
ScribbleNet
│
├── client
│   └── index.html
│
├── server
│   └── index.js
│
├── package.json
└── README.md
```

## How to Run

### Install Dependencies

```bash
npm install
```

### Configure API Key (Optional)

```env
ANTHROPIC_API_KEY=your_api_key
```

If no API key is provided, the application automatically uses the built-in fallback word bank.

### Start the Server

```bash
node server/index.js
```

Server starts on:

```text
http://localhost:3000
```

---

## Running with Ngrok

Start the application:

```bash
node server/index.js
```

In another terminal:

```bash
ngrok http 3000
```

Ngrok generates a public URL such as:

```text
https://xxxx.ngrok-free.app
```

Share this URL with other players so they can join the game from different networks.

---

## Learning Outcomes

* Real-time communication using WebSockets
* Distributed event handling
* State synchronization
* Room-based distributed architecture
* Fault tolerance handling
* Multiplayer game coordination
* Client-server communication
* AI integration in distributed applications

```
```
