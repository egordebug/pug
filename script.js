const firebaseConfig = {
  apiKey: "AIzaSyBglqZ7HP42c3m-cjbZT95fJhttRQRxNqM",
  authDomain: "maranuchook.firebaseapp.com",
  projectId: "maranuchook",
  storageBucket: "maranuchook.firebasestorage.app",
  messagingSenderId: "607472317729",
  appId: "1:607472317729:web:6838cbe7645855800aba60"
};

// Инициализация
if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();
const storage = firebase.storage();

// === ГЛОБАЛЬНОЕ СОСТОЯНИЕ ===
const state = {
    user: null,         // Текущий профиль пользователя
    contacts: [],       // Список друзей
    groups: [],         // Список групп
    activeChat: null,   // ID открытого чата
    chatType: null,     // 'user' или 'group'
    listeners: {        // Активные подписки (чтобы отключать их)
        chat: null,
        groups: null
    },
    mediaRecorder: null,
    chunks: []
};

// === 1. ИНИЦИАЛИЗАЦИЯ И AUTH ===

window.onload = () => {
    // Проверка авторизации
    auth.onAuthStateChanged(async (firebaseUser) => {
        if (firebaseUser) {
            await loadUserProfile(firebaseUser.uid);
            initApp();
        } else {
            UI.openModal('modalWelcome');
            Utils.setRandomAvatar('setupAvatar', 'welcomePreview');
        }
    });

    // Авто-ресайз поля ввода
    const input = document.getElementById('msgInput');
    input.addEventListener('input', function() {
        this.style.height = 'auto'; 
        this.style.height = (this.scrollHeight) + 'px';
    });
    
    // Отправка по Enter (Shift+Enter для переноса)
    input.addEventListener('keydown', (e) => {
        if(e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMsg();
        }
    });
};

async function handleAuth() {
    const email = val('setupEmail');
    const pass = val('setupPassword');
    const shortId = val('setupShortId').toLowerCase();
    const name = val('setupName');
    const avatar = val('setupAvatar');

    if (!email || !pass) return UI.toast('Введите Email и пароль');

    try {
        // Пробуем войти
        await auth.signInWithEmailAndPassword(email, pass);
    } catch (e) {
        // Если пользователя нет — регистрируем
        if (e.code === 'auth/user-not-found' || e.code === 'auth/invalid-credential') {
            if (!shortId || !name) return UI.toast('Заполните все поля для регистрации');
            
            // Проверка уникальности ID
            const check = await db.collection('users').where('shortId', '==', shortId).get();
            if (!check.empty) return UI.toast('Этот ID занят');

            const cred = await auth.createUserWithEmailAndPassword(email, pass);
            const newUser = {
                id: cred.user.uid,
                email, shortId, name,
                avatar: avatar || `https://ui-avatars.com/api/?name=${name}`,
                contacts: [],
                createdAt: Date.now()
            };
            
            await db.collection('users').doc(cred.user.uid).set(newUser);
            state.user = newUser;
        } else {
            UI.toast(e.message);
        }
    }
    UI.closeModals();
}

async function loadUserProfile(uid) {
    const doc = await db.collection('users').doc(uid).get();
    if (doc.exists) {
        state.user = doc.data();
        updateHeaderUI();
        // Обновляем статус "в сети"
        db.collection('users').doc(uid).update({ lastSeen: Date.now() });
    }
}

function initApp() {
    loadContacts();
    listenToGroups();
    UI.closeModals();
}

// === 2. ДАННЫЕ (КОНТАКТЫ И ГРУППЫ) ===

async function loadContacts() {
    if (!state.user.contacts || !state.user.contacts.length) return renderContactList();
    
    // Firestore in-query (до 10 элементов, для продакшена лучше разбивать на части)
    const chunks = [];
    const list = state.user.contacts;
    for (let i = 0; i < list.length; i += 10) {
        chunks.push(list.slice(i, i + 10));
    }

    state.contacts = [];
    for (const chunk of chunks) {
        const snap = await db.collection('users').where(firebase.firestore.FieldPath.documentId(), 'in', chunk).get();
        snap.forEach(doc => state.contacts.push({ id: doc.id, ...doc.data() }));
    }
    renderContactList();
}

function listenToGroups() {
    if (state.listeners.groups) state.listeners.groups();
    state.listeners.groups = db.collection('groups')
        .where('members', 'array-contains', state.user.id)
        .onSnapshot(snap => {
            state.groups = snap.docs.map(d => ({ id: d.id, ...d.data(), type: 'group' }));
            renderContactList();
        });
}

async function addContact() {
    const targetId = val('addId').trim().toLowerCase();
    if (!targetId) return;
    
    const snap = await db.collection('users').where('shortId', '==', targetId).get();
    if (snap.empty) return UI.toast('Пользователь не найден');
    
    const friend = snap.docs[0].data();
    if (friend.id === state.user.id) return UI.toast('Это вы');

    await db.collection('users').doc(state.user.id).update({
        contacts: firebase.firestore.FieldValue.arrayUnion(friend.id)
    });
    
    state.user.contacts.push(friend.id);
    await loadContacts();
    UI.closeModals();
    UI.toast('Контакт добавлен');
}

// === 3. РЕНДЕРИНГ ИНТЕРФЕЙСА ===

function renderContactList() {
    const list = document.getElementById('contactList');
    list.innerHTML = '';

    // Сначала группы
    state.groups.forEach(g => {
        const el = Utils.createContactEl(g, true);
        el.onclick = () => openChat(g.id, 'group', g);
        list.appendChild(el);
    });

    // Потом люди
    state.contacts.forEach(c => {
        const el = Utils.createContactEl(c, false);
        el.onclick = () => openChat(c.id, 'user', c);
        list.appendChild(el);
    });
}

function updateHeaderUI() {
    document.getElementById('myAvatarDisplay').src = state.user.avatar;
    document.getElementById('myNameDisplay').innerText = state.user.name;
    document.getElementById('myIdDisplay').innerText = '@' + state.user.shortId;
}

// === 4. ЧАТ (ЯДРО) ===

function openChat(id, type, data) {
    if (state.activeChat === id) return;
    
    state.activeChat = id;
    state.chatType = type;

    // UI Переключения
    document.querySelectorAll('.contact').forEach(c => c.classList.remove('active'));
    // (Тут можно добавить подсветку активного контакта по ID)
    
    // Мобильная адаптация
    document.getElementById('sidebar').classList.add('hidden');
    document.getElementById('chatArea').classList.add('active');

    // Заголовок чата
    document.getElementById('chatAvatar').src = data.avatar;
    document.getElementById('chatName').innerText = data.name;
    document.getElementById('chatStatus').innerText = type === 'group' 
        ? `${data.members.length} участников` 
        : `@${data.shortId}`;

    // Загрузка сообщений
    loadMessages(id, type);
}

function loadMessages(targetId, type) {
    const list = document.getElementById('messages');
    list.innerHTML = ''; // Очистка
    
    if (state.listeners.chat) state.listeners.chat();

    let query = db.collection('messages');
    
    if (type === 'group') {
        query = query.where('groupId', '==', targetId);
    } else {
        // Генерируем уникальный ID диалога: minUID_maxUID
        const chatId = [state.user.id, targetId].sort().join('_');
        query = query.where('chatId', '==', chatId);
    }

    state.listeners.chat = query.orderBy('time', 'asc').onSnapshot(snapshot => {
        // Используем docChanges для оптимизации (чтобы не перерисовывать всё)
        snapshot.docChanges().forEach(change => {
            if (change.type === 'added') {
                renderMessage(change.doc.data(), change.doc.id);
            }
        });
        Utils.scrollToBottom();
    });
}

function renderMessage(msg, id) {
    const list = document.getElementById('messages');
    const isMine = msg.sender === state.user.id;
    
    const div = document.createElement('div');
    div.className = `msg ${isMine ? 'out' : 'in'}`;
    
    let contentHtml = '';
    
    switch(msg.type) {
        case 'text': 
            contentHtml = Utils.escapeHtml(msg.content).replace(/\n/g, '<br>'); 
            break;
        case 'image': 
            contentHtml = `<div class="msg-content"><img src="${msg.content}" onclick="viewFullScreen(this.src)" loading="lazy"></div>`; 
            break;
        case 'video':
            contentHtml = `<video src="${msg.content}" controls style="max-width:100%; border-radius:12px;"></video>`;
            break;
        case 'audio':
            contentHtml = `<audio controls src="${msg.content}"></audio>`;
            break;
        case 'video_note':
            contentHtml = `<video src="${msg.content}" autoplay loop muted playsinline style="width:140px; height:140px; border-radius:50%; object-fit:cover; border:2px solid var(--accent);" onclick="this.muted=!this.muted"></video>`;
            break;
    }

    // Имя отправителя в группах
    const senderHtml = (state.chatType === 'group' && !isMine) 
        ? `<span class="sender-name">${msg.senderName}</span>` : '';

    div.innerHTML = `
        ${senderHtml}
        ${contentHtml}
        <div class="msg-meta">
            ${new Date(msg.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
        </div>
    `;
    
    list.appendChild(div);
}

async function sendMsg(customPayload = null) {
    if (!state.activeChat) return;

    const input = document.getElementById('msgInput');
    const text = input.value.trim();
    
    if (!text && !customPayload) return;

    const msgData = {
        sender: state.user.id,
        senderName: state.user.name,
        time: Date.now(),
        type: customPayload ? customPayload.type : 'text',
        content: customPayload ? customPayload.content : text
    };

    if (state.chatType === 'group') {
        msgData.groupId = state.activeChat;
    } else {
        msgData.chatId = [state.user.id, state.activeChat].sort().join('_');
    }

    try {
        await db.collection('messages').add(msgData);
        if (!customPayload) {
            input.value = '';
            input.style.height = '42px'; // Сброс высоты
        }
    } catch (e) {
        UI.toast('Ошибка отправки');
    }
}

// === 5. МЕДИА (ФОТО, ГОЛОС, ВИДЕО-КРУЖКИ) ===

async function sendFile(input) {
    const file = input.files[0];
    if (!file) return;
    
    UI.toast('Загрузка...');
    const type = file.type.startsWith('video') ? 'video' : 'image';
    const url = await uploadToStorage(file, type);
    sendMsg({ type, content: url });
    input.value = ''; // Сброс
}

async function toggleRecord(mode) {
    const btn = document.getElementById(mode === 'audio' ? 'voiceBtn' : 'videoBtn');
    
    if (state.mediaRecorder) {
        state.mediaRecorder.stop();
        btn.classList.remove('rec');
        return;
    }

    try {
        const constraints = mode === 'audio' ? { audio: true } : { video: { facingMode: "user", aspectRatio: 1 }, audio: true };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        
        state.mediaRecorder = new MediaRecorder(stream);
        state.chunks = [];

        state.mediaRecorder.ondataavailable = e => state.chunks.push(e.data);
        state.mediaRecorder.onstop = async () => {
            UI.toast('Отправка...');
            const blob = new Blob(state.chunks, { type: mode === 'audio' ? 'audio/webm' : 'video/webm' });
            const url = await uploadToStorage(blob, mode === 'audio' ? 'audio' : 'video_note', 'webm');
            sendMsg({ type: mode === 'audio' ? 'audio' : 'video_note', content: url });
            
            stream.getTracks().forEach(t => t.stop()); // Выключаем камеру/микро
            state.mediaRecorder = null;
        };

        state.mediaRecorder.start();
        btn.classList.add('rec');
        UI.toast(mode === 'audio' ? 'Запись голоса...' : 'Запись видео...');

    } catch (e) {
        UI.toast('Нет доступа к микрофону/камере');
    }
}

async function uploadToStorage(blob, folder, ext = 'jpg') {
    const ref = storage.ref(`media/${state.user.id}/${Date.now()}.${ext}`);
    await ref.put(blob);
    return await ref.getDownloadURL();
}

// === 6. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (UI) ===

function closeChat() {
    document.getElementById('sidebar').classList.remove('hidden');
    document.getElementById('chatArea').classList.remove('active');
    state.activeChat = null;
    if (state.listeners.chat) {
        state.listeners.chat();
        state.listeners.chat = null;
    }
}

const UI = {
    openModal: (id) => {
        const el = document.getElementById(id);
        if(el) {
            el.style.display = 'flex';
            setTimeout(() => el.classList.add('open'), 10);
        }
    },
    closeModals: () => {
        document.querySelectorAll('.modal-overlay').forEach(el => {
            el.classList.remove('open');
            setTimeout(() => el.style.display = 'none', 300);
        });
    },
    toast: (msg) => {
        const t = document.getElementById('toast');
        t.innerText = msg;
        t.style.opacity = 1;
        setTimeout(() => t.style.opacity = 0, 3000);
    }
};

const Utils = {
    setRandomAvatar: (inputId, imgId) => {
        const url = `https://ui-avatars.com/api/?name=${Math.random().toString(36).substring(7)}&background=random&color=fff`;
        document.getElementById(inputId).value = url;
        if(imgId) document.getElementById(imgId).src = url;
    },
    createContactEl: (data, isGroup) => {
        const div = document.createElement('div');
        div.className = 'contact';
        div.innerHTML = `
            <img src="${data.avatar}" class="avatar">
            <div style="flex:1; overflow:hidden;">
                <div style="font-weight:600; font-size:15px; color:var(--text)">
                    ${isGroup ? '<i class="fas fa-users" style="font-size:12px; margin-right:5px"></i>' : ''}
                    ${data.name}
                </div>
                <div style="font-size:13px; color:var(--text-sec); text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">
                    ${isGroup ? 'Группа' : '@' + data.shortId}
                </div>
            </div>
        `;
        return div;
    },
    scrollToBottom: () => {
    const d = document.getElementById('messages');
    requestAnimationFrame(() => {
        d.scrollTop = d.scrollHeight;
    });
},


// Хелперы для HTML кнопок
function val(id) { return document.getElementById(id).value; }
function toggleFabMenu() { document.getElementById('fabMenu').classList.toggle('open'); }
function viewFullScreen(src) { document.getElementById('lightboxImg').src = src; document.getElementById('lightbox').classList.add('open'); }
function closeLightbox() { document.getElementById('lightbox').classList.remove('open'); }
function openModal(id) { UI.openModal(id); }
function closeModals() { UI.closeModals(); }
function copyMyId() { navigator.clipboard.writeText(state.user.shortId); UI.toast('Скопировано'); }

// Заглушки для недостающих модалок (на случай клика)
// === 7. СОЗДАНИЕ ГРУПП ===

async function openCreateGroupModal() {
    const list = document.getElementById('groupUserList');
    list.innerHTML = '';
    
    if (!state.contacts.length) {
        list.innerHTML = '<div style="font-size:12px; opacity:0.5; padding:10px;">Сначала добавьте хотя бы одного друга</div>';
    }

    state.contacts.forEach(c => {
        const item = document.createElement('div');
        item.style = "display:flex; align-items:center; gap:10px; margin-bottom:8px; background:rgba(255,255,255,0.05); padding:8px; border-radius:10px;";
        item.innerHTML = `
            <input type="checkbox" value="${c.id}" id="chk_${c.id}" style="width:18px; height:18px;">
            <img src="${c.avatar}" style="width:30px; height:30px; border-radius:50%;">
            <label for="chk_${c.id}" style="flex:1; cursor:pointer;">${c.name}</label>
        `;
        list.appendChild(item);
    });
    
    UI.openModal('modalCreateGroup');
}

// === 8. НАСТРОЙКИ ПРОФИЛЯ ===

function openSettings() {
    document.getElementById('setMyName').value = state.user.name;
    document.getElementById('setMyAvatar').value = state.user.avatar;
    UI.openModal('modalSettings');
}

async function saveSettings() {
    const newName = val('setMyName').trim();
    const newAvatar = val('setMyAvatar').trim();

    if (!newName) return UI.toast('Имя не может быть пустым');

    await db.collection('users').doc(state.user.id).update({
        name: newName,
        avatar: newAvatar
    });

    state.user.name = newName;
    state.user.avatar = newAvatar;
    updateHeaderUI();
    UI.closeModals();
    UI.toast('Профиль обновлен');
}

async function logout() {
    if (confirm('Выйти из аккаунта?')) {
        await auth.signOut();
        location.reload();
    }
}

// === 9. ОПЦИИ КОНТАКТА И УДАЛЕНИЕ ===

function openContactOptions(id) {
    if (!id) return;
    const data = state.chatType === 'group' 
        ? state.groups.find(g => g.id === id) 
        : state.contacts.find(c => c.id === id);
    
    if (!data) return;
    document.getElementById('optName').innerText = data.name;
    UI.openModal('modalOptions');
}
function closeChat() {
    const sidebar = document.getElementById('sidebar');
    const chatArea = document.getElementById('chatArea');
    
    if (sidebar) sidebar.classList.remove('hidden');
    if (chatArea) chatArea.classList.remove('active');
    
    state.activeChat = null;
    if (state.listeners.chat) {
        state.listeners.chat();
        state.listeners.chat = null;
    }
}
async function deleteContactFromOptions() {
    if (!confirm('Удалить этот чат из списка контактов? История сообщений не удалится.')) return;

    try {
        if (state.chatType === 'user') {
            await db.collection('users').doc(state.user.id).update({
                contacts: firebase.firestore.FieldValue.arrayRemove(state.activeChat)
            });
            state.user.contacts = state.user.contacts.filter(id => id !== state.activeChat);
            await loadContacts();
        } else {
            // Если это группа — просто выходим из неё
            await db.collection('groups').doc(state.activeChat).update({
                members: firebase.firestore.FieldValue.arrayRemove(state.user.id)
            });
        }
        closeChat();
        UI.closeModals();
        UI.toast('Удалено');
    } catch (e) {
        UI.toast('Ошибка удаления');
    }
}

// Переключение шагов создания группы
function groupNextStep(step) {
    const s1 = document.getElementById('groupStep1');
    const s2 = document.getElementById('groupStep2');
    
    if (step === 2) {
        if (!val('newGroupName').trim()) return UI.toast('Введите название группы');
        s1.style.display = 'none';
        s2.style.display = 'block';
        renderGroupContactList(); // Показываем список друзей при переходе
    } else {
        s1.style.display = 'block';
        s2.style.display = 'none';
    }
}

// Поиск пользователя в базе по его shortId
async function searchUserForGroup(query) {
    const resDiv = document.getElementById('searchResult');
    query = query.trim().toLowerCase();
    
    if (query.length < 3) {
        resDiv.innerHTML = '';
        return;
    }

    // Ищем в Firebase по полю shortId
    const snap = await db.collection('users').where('shortId', '==', query).get();
    
    if (snap.empty) {
        resDiv.innerHTML = '<div style="font-size:12px; opacity:0.5; padding:5px;">Пользователь не найден</div>';
    } else {
        const u = snap.docs[0].data();
        if (u.id === state.user.id) return; // Себя не ищем

        resDiv.innerHTML = `
            <div class="contact" style="background:rgba(255,255,255,0.1); border-radius:12px; padding:8px; display:flex; align-items:center; gap:10px; cursor:pointer;" onclick="addFoundToGroupList('${u.id}', '${u.name}', '${u.avatar}')">
                <img src="${u.avatar}" class="avatar" style="width:30px; height:30px;">
                <div style="flex:1">
                    <div style="font-size:13px; font-weight:600;">${u.name}</div>
                    <div style="font-size:11px; opacity:0.6;">@${u.shortId}</div>
                </div>
                <i class="fas fa-plus-circle" style="color:var(--accent)"></i>
            </div>
        `;
    }
}

// Добавляет найденного юзера в список выбора сверху
function addFoundToGroupList(id, name, avatar) {
    const list = document.getElementById('groupUserList');
    if (document.getElementById(`chk_${id}`)) return UI.toast('Уже добавлен');

    const div = document.createElement('div');
    div.style = "display:flex; align-items:center; gap:10px; padding:8px; border-bottom:1px solid var(--border);";
    div.innerHTML = `
        <input type="checkbox" value="${id}" id="chk_${id}" checked style="width:18px; height:18px;">
        <img src="${avatar}" style="width:30px; height:30px; border-radius:50%;">
        <label for="chk_${id}" style="flex:1; cursor:pointer; font-size:14px;">${name}</label>
    `;
    list.prepend(div);
    document.getElementById('groupUserSearch').value = '';
    document.getElementById('searchResult').innerHTML = '';
}

// Загрузка твоих текущих друзей в список участников
function renderGroupContactList() {
    const list = document.getElementById('groupUserList');
    // Сохраняем уже отмеченных, чтобы не сбросить при рендере
    const selected = Array.from(document.querySelectorAll('#groupUserList input:checked')).map(i => i.value);
    list.innerHTML = '';

    state.contacts.forEach(c => {
        const div = document.createElement('div');
        div.style = "display:flex; align-items:center; gap:10px; padding:8px; border-bottom:1px solid var(--border);";
        div.innerHTML = `
            <input type="checkbox" value="${c.id}" id="chk_${c.id}" ${selected.includes(c.id) ? 'checked' : ''} style="width:18px; height:18px;">
            <img src="${c.avatar}" style="width:30px; height:30px; border-radius:50%;">
            <label for="chk_${c.id}" style="flex:1; cursor:pointer; font-size:14px;">${c.name}</label>
        `;
        list.appendChild(div);
    });
}

// Финальная сборка группы
async function finishCreateGroup() {
    const name = val('newGroupName').trim();
    const avatar = document.getElementById('newGroupPreview').src;
    
    // Собираем ID из чекбоксов
    const checkboxes = document.querySelectorAll('#groupUserList input[type="checkbox"]:checked');
    let members = Array.from(checkboxes).map(cb => cb.value);
    
    // Добавляем ID из ручного ввода (через запятую)
    const manual = val('manualIds').trim();
    if (manual) {
        const manualArray = manual.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
        // Тут можно добавить проверку в базе, но для скорости добавим "как есть" или через поиск
        const snap = await db.collection('users').where('shortId', 'in', manualArray).get();
        snap.forEach(doc => members.push(doc.id));
    }

    members = [...new Set([state.user.id, ...members])]; // Убираем дубли и добавляем себя

    if (members.length < 2) return UI.toast('Нужно минимум 2 участника');

    try {
        await db.collection('groups').add({
            name,
            avatar,
            admin: state.user.id,
            members,
            createdAt: Date.now(),
            lastMsgTime: Date.now()
        });
        UI.toast('Группа создана!');
        UI.closeModals();
        // Сброс полей
        document.getElementById('newGroupName').value = '';
        document.getElementById('manualIds').value = '';
    } catch (e) {
        UI.toast('Ошибка создания');
    }
}


function viewAvatarFromOptions() {
    const avatarImg = document.getElementById('chatAvatar').src;
    viewFullScreen(avatarImg);
    UI.closeModals();
}

