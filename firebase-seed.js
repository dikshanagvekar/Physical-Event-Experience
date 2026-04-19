/**
 * firebase-seed.js — One-time Firebase Realtime Database seeder
 *
 * Run once to populate your Firebase DB with the initial venue data.
 * After this, your IoT/admin systems update the /liveData node.
 *
 * Usage:
 *   npm install firebase-admin
 *   node firebase-seed.js
 *
 * Requirements:
 *   - Download your Firebase service account key from:
 *     Firebase Console → Project Settings → Service Accounts → Generate new private key
 *   - Save it as serviceAccountKey.json in this directory
 */

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); // ← your downloaded key
const venueData = require('./data/venue.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://YOUR_PROJECT-default-rtdb.asia-southeast1.firebasedatabase.app' // ← your DB URL
});

const db = admin.database();

async function seed() {
  try {
    console.log('🌱 Seeding Firebase Realtime Database...');

    // Write base venue structure
    await db.ref('/venue').set({
      name: venueData.venue.name,
      capacity: venueData.venue.capacity,
      event: venueData.venue.event,
      teams: venueData.venue.teams,
      matchTime: venueData.venue.matchTime,
      location: venueData.venue.location,
    });

    // Write live data (this is what gets updated by IoT/admin)
    await db.ref('/liveData').set({
      gates:       venueData.gates,
      zones:       venueData.zones,
      concessions: venueData.concessions,
      restrooms:   venueData.restrooms,
      parking:     venueData.parking,
      alerts:      venueData.alerts,
      lastUpdated: Date.now(),
    });

    console.log('✅ Seed complete! Firebase DB is ready.');
    console.log('   Your app will now read from /liveData in real-time.');
    console.log('');
    console.log('📡 IoT / Admin updates:');
    console.log('   db.ref("/liveData/gates/0/queue").set(12);  // Gate A queue = 12 min');
    console.log('   db.ref("/liveData/zones/0/density").set(0.75);  // North Stand 75%');

    process.exit(0);
  } catch (err) {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  }
}

seed();
