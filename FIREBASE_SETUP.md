# Finora — Firebase + PWA setup

## 1. Firebase project
Create a Firebase project and register a Web App.

## 2. Put the Firebase Web App config into `script.js`
Find:

`const FIREBASE_CONFIG = { ... }`

Replace the placeholder values with the Web App config from:
Firebase Console → Project settings → Your apps → Web app.

## 3. Enable Google Login
Firebase Console → Authentication → Sign-in method → Google → Enable.

## 4. Create Firestore
Firebase Console → Firestore Database → Create database.

Then deploy the included `firestore.rules`.

## 5. Data architecture
The app stores the current tracker payload at:

`users/{uid}/app/state`

The authenticated Google UID is the owner of that data.

## 6. Offline behavior
The app keeps its normal IndexedDB/localStorage data locally.
When the user is signed in, Firestore offline persistence queues cloud writes.
When the connection returns, queued data is uploaded and the live listener
updates other signed-in devices.

## 7. PWA
The project includes:
- manifest.json
- sw.js
- 192px and 512px icons
- install prompt
- cached app shell
- runtime caching for the existing CDN libraries

The app must be served over HTTPS (or localhost during development).
Do not test Google authentication from a `file://` URL.

## 8. Deploy
Install Firebase CLI, log in, select the project, then deploy:

`firebase login`
`firebase use --add`
`firebase deploy`

The Firebase web configuration is client configuration, not a password.
Protect user data with Authentication + Firestore Security Rules.

## Important cloud-sync note
This first cloud version syncs the existing app state as one Firestore document.
It is intentionally compatible with the current application architecture.
If the transaction history becomes very large, move transactions to a Firestore
subcollection to avoid the Firestore document-size limit.


## Monthly email reports (one-time maintainer setup)
The end user enters only their email address in Tools → Monthly Report. For sending to work on a fresh browser, the project maintainer must configure EmailJS Service ID, Template ID, and Public Key once in the Email Settings disclosure. These values are not passwords, but use EmailJS domain restrictions and rate limits to reduce abuse. The report currently sends a summary of the current month's transactions; it does not attach a PDF.

## AI/forecast wording
The current dashboard forecast is a lightweight weighted estimate using current-month run rate, recent monthly totals, and category seasonality. It is not a trained machine-learning model. Describe it as an estimated spending forecast unless a trained model is added.
