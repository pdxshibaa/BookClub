import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

// TODO: Replace the following with your app's Firebase project configuration
// You can find this in the Firebase Console -> Project Settings -> General -> "Your apps"
const firebaseConfig = {
  apiKey: "AIzaSyAbIWMqgTOnkQ0jE02f7BpDm0JkhZYpjQk",
  authDomain: "bookclubbackend.firebaseapp.com",
  projectId: "bookclubbackend",
  storageBucket: "bookclubbackend.firebasestorage.app",
  messagingSenderId: "219050497346",
  appId: "1:219050497346:web:85e8c71bf341ca3c8164db",
  measurementId: "G-ZGKWVBZN6G"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);