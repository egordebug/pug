importScripts('https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js');
importScripts('https://www.gstatic.com/firebasejs/8.10.1/firebase-messaging.js');

firebase.initializeApp({
  apiKey: "AIzaSyBglqZ7HP42c3m-cjbZT95fJhttRQRxNqM",
  projectId: "maranuchook",
  messagingSenderId: "607472317729",
  appId: "1:607472317729:web:6838cbe7645855800aba60"
});

const messaging = firebase.messaging();

// Фоновая обработка пуша
messaging.onBackgroundMessage((payload) => {
  console.log('Получен пуш в фоне:', payload);
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: '/icon.png' // Путь к иконке твоего мема
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});
