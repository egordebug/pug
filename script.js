// === КОНФИГУРАЦИЯ FIREBASE ===
const firebaseConfig = {
  apiKey: "AIzaSyBglqZ7HP42c3m-cjbZT95fJhttRQRxNqM",
  authDomain: "maranuchook.firebaseapp.com",
  projectId: "maranuchook",
  storageBucket: "maranuchook.firebasestorage.app",
  messagingSenderId: "607472317729",
  appId: "1:607472317729:web:6838cbe7645855800aba60"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

// === СОСТОЯНИЕ ===
let state = {
    profile: { name: '', id: '', shortId: '', avatar: '' },
    contacts: [], // Теперь просто пустой массив, он заполнится из базы
    groups: [] 
};


let activeChat = null; // ID юзера ИЛИ ID группы
let activeChatType = null; // 'user' или 'group'
let optionsTargetId = null;
let mediaRecorder = null;
let recordedChunks = [];
let currentUnsubscribe = null;
let groupsUnsubscribe = null;

// === ИНИЦИАЛИЗАЦИЯ ===
window.onload = () => {
    auth.onAuthStateChanged(async (user) => {
        if (user) {
            try {
                // 1. Грузим профиль
                const doc = await db.collection("users").doc(user.uid).get();
                if (doc.exists) {
                    state.profile = doc.data();
                    updateSelfUI();
                    
                    // 2. Слушаем группы, где я участник
                    listenToData(user.uid);
                    
                    // 3. Рендерим контакты(убрал как ты и сказал)
                    
                    closeModals();
                    db.collection("users").doc(user.uid).update({ lastSeen: Date.now() }).catch(()=>{});
                    checkUrlParams();
                } else {
                    openModal('modalWelcome');
                }
            } catch (err) {
                console.error("Error:", err);
                showToast("Ошибка загрузки профиля");
            }
        } else {
            openModal('modalWelcome');
            setRandomAvatar('setupAvatar', 'welcomePreview');
        }
    });
};
// Переменные для 

function listenToData(myUid) {
    // 1. Слушаем ГРУППЫ
    if(groupsUnsubscribe) groupsUnsubscribe();
    groupsUnsubscribe = db.collection("groups")
        .where("members", "array-contains", myUid)
        .onSnapshot(snapshot => {
            state.groups = [];
            snapshot.forEach(doc => {
                state.groups.push({ id: doc.id, ...doc.data(), type: 'group' });
            });
            renderContactList();
        });

    // 2. Слушаем ЛИЧНЫЕ ЧАТЫ (Вместо LocalStorage)
    if(chatsUnsubscribe) chatsUnsubscribe();
    chatsUnsubscribe = db.collection("chats")
        .where("members", "array-contains", myUid)
        .onSnapshot(async (snapshot) => {
            // Нам нужно получить данные собеседника для каждого чата
            const contactsPromises = snapshot.docs.map(async doc => {
                const data = doc.data();
                // Находим ID собеседника (тот, который не мой)
                const partnerId = data.members.find(id => id !== myUid);
                
                if (partnerId) {
                    // Загружаем инфо о собеседнике из users
                    const userDoc = await db.collection("users").doc(partnerId).get();
                    if (userDoc.exists) {
                        return userDoc.data();
                    }
                }
                return null;
            });

            // Ждем пока загрузятся все профили
            const resolvedContacts = await Promise.all(contactsPromises);
            
            // Фильтруем пустые (если вдруг юзер удален) и обновляем state
            state.contacts = resolvedContacts.filter(c => c !== null);
            
            renderContactList();
        });
}


function openCreateGroupModal() {
    const list = document.getElementById('groupUserList');
    const contactSection = document.getElementById('groupContactSection');
    const manualLabel = document.getElementById('manualLabel');
    
    list.innerHTML = '';
    
    if (!state.contacts || state.contacts.length === 0) {
        // Если контактов нет — скрываем блок со списком
        contactSection.style.display = 'none';
        manualLabel.innerText = "У вас нет контактов. Введите ID участников через запятую:";
    } else {
        // Если контакты есть — показываем всё красиво
        contactSection.style.display = 'block';
        manualLabel.innerText = "Или добавьте других по ID (через запятую):";
        
        state.contacts.forEach(c => {
            const div = document.createElement('div');
            div.className = 'user-select-item';
            div.style = 'display:flex; align-items:center; padding:8px; gap:10px; border-bottom:1px solid var(--sec);';
            div.innerHTML = `
                <input type="checkbox" value="${c.id}" id="chk_${c.id}" style="width:18px; height:18px;">
                <img src="${c.avatar}" style="width:32px; height:32px; border-radius:50%; object-fit:cover;">
                <label for="chk_${c.id}" style="flex:1; cursor:pointer; font-size:14px;">${c.name}</label>
            `;
            list.appendChild(div);
        });
    }
    
    openModal('modalCreateGroup');
}


async function finishCreateGroup() {
    const name = document.getElementById('newGroupName').value.trim();
    if(!name) return showToast('Назовите группу!');
    
    const checkboxes = document.querySelectorAll('#groupUserList input[type="checkbox"]:checked');
    const checkedIds = Array.from(checkboxes).map(cb => cb.value);
    
    const manualInput = document.getElementById('manualIds').value.trim();
    let finalUids = [...checkedIds];

    try {
        if (manualInput) {
            const manualIds = manualInput.split(',').map(id => id.trim().toLowerCase()).filter(id => id);
            // Ищем UID по коротким ID в базе
            const usersSnap = await db.collection("users").where("shortId", "in", manualIds).get();
            usersSnap.forEach(doc => finalUids.push(doc.data().id));
        }

        const members = [...new Set([state.profile.id, ...finalUids])];
        if (members.length < 2) return showToast("Нужен хотя бы один участник кроме вас");

        await db.collection("groups").add({
            name: name,
            members: members,
            admin: state.profile.id,
            avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=random&color=fff`,
            createdAt: Date.now()
        });

        showToast('Группа создана!');
        closeModals();
        // Очистка полей
        document.getElementById('newGroupName').value = '';
        document.getElementById('manualIds').value = '';
    } catch(e) {
        showToast('Ошибка. Проверьте правильность ID');
    }
}


// === АВТОРИЗАЦИЯ ===
async function handleAuth() {
    const email = document.getElementById('setupEmail').value.trim();
    const password = document.getElementById('setupPassword').value.trim();
    const shortId = document.getElementById('setupShortId').value.trim().toLowerCase();
    const name = document.getElementById('setupName').value.trim();
    const avatar = document.getElementById('setupAvatar').value;

    if (!email || !password) return showToast('Введите Email и Пароль');

    try {
        await auth.signInWithEmailAndPassword(email, password);
        showToast("Вход выполнен!");
    } catch (loginError) {
        if (loginError.code === 'auth/user-not-found' || loginError.code === 'auth/invalid-credential') {
            if (!shortId || !name) return showToast('Для регистрации нужны ID и Имя');
            // Проверка ID (теперь разрешена правилами)
            const idCheck = await db.collection("users").where("shortId", "==", shortId).get();
            if (!idCheck.empty) return showToast('Этот ID уже занят');

            const newUser = await auth.createUserWithEmailAndPassword(email, password);
            const profileData = {
                id: newUser.user.uid,
                shortId, name, email,
                avatar: avatar || `https://ui-avatars.com/api/?name=${name}`,
                createdAt: Date.now()
            };
            await db.collection("users").doc(newUser.user.uid).set(profileData);
            state.profile = profileData;
            showToast("Аккаунт создан!");
            closeModals();
        } else {
            showToast("Ошибка: " + loginError.message);
        }
    }
}

function logout() {
    if(confirm('Выйти?')) {
        auth.signOut();
        localStorage.clear();
        location.reload();
    }
}

// === ЧАТ ===
function getChatId(user1, user2) {
    return [user1, user2].sort().join('_');
}

function loadChat(targetId, type = 'user') {
    activeChat = targetId;
    activeChatType = type;
    
    // 1. Сразу чистим экран, чтобы не видеть сообщения из прошлого чата
    const list = document.getElementById('messages');
    list.innerHTML = '<div style="text-align:center; padding:20px; opacity:0.5;">Загрузка...</div>';
    
    // UI переключение
    document.getElementById('chatWrap').classList.add('active');
    document.getElementById('sidebar').classList.add('hidden');
    
    let name, avatar;
    
    if (type === 'group') {
        const grp = state.groups.find(g => g.id === targetId);
        name = grp ? grp.name : 'Группа';
        avatar = grp ? grp.avatar : '';
        document.getElementById('chatStatus').innerText = `${grp ? grp.members.length : 0} участников`;
    } else {
        const usr = state.contacts.find(c => c.id === targetId);
        name = usr ? usr.name : 'User';
        avatar = usr ? usr.avatar : '';
        document.getElementById('chatStatus').innerText = 'В сети';
    }

    document.getElementById('chatName').innerText = name;
    document.getElementById('chatAvatar').src = avatar;
    
    // 2. Отписываемся от старого чата перед созданием нового слушателя
    if (currentUnsubscribe) {
        currentUnsubscribe();
        currentUnsubscribe = null;
    }

    // 3. Формируем чистый запрос
    let msgQuery = db.collection("messages");

    if (type === 'group') {
        // Ищем ТОЛЬКО по groupId
        msgQuery = msgQuery.where("groupId", "==", targetId);
    } else {
        // Ищем ТОЛЬКО по chatId (личка)
        const combinedId = getChatId(state.profile.id, targetId);
        msgQuery = msgQuery.where("chatId", "==", combinedId);
    }

    // Добавляем сортировку по времени
    msgQuery = msgQuery.orderBy("time", "asc");

    currentUnsubscribe = msgQuery.onSnapshot((snapshot) => {
        const msgs = [];
        snapshot.forEach(doc => {
            msgs.push({ id: doc.id, ...doc.data() });
        });
        renderMessages(msgs);
    }, (error) => {
        console.error("Ошибка Firestore:", error);
        if (error.code === 'failed-precondition') {
            showToast("Нужно создать индексы в консоли Firebase");
        }
    });
}


function renderMessages(msgs) {
    const list = document.getElementById('messages');
    list.innerHTML = '';
    
    msgs.forEach(m => {
        const isMine = m.sender === state.profile.id;
        let content = '';
        let extraClass = '';
        
        if (m.type === 'text') content = m.content.replace(/\n/g, '<br>');
        else if (m.type === 'image') content = `<img src="${m.content}" onclick="viewFullScreen(this.src)">`;
        else if (m.type === 'audio') content = `<audio controls src="${m.content}"></audio>`;
        else if (m.type === 'video_note') {
            extraClass = 'has-circle';
            content = `<video class="circle-msg" src="${m.content}" autoplay loop muted playsinline onclick="this.muted = !this.muted"></video>`;
        }
        else if (m.type === 'video') content = `<video src="${m.content}" controls style="max-width:100%; border-radius:12px;"></video>`;

        const div = document.createElement('div');
        div.className = `msg ${isMine ? 'out' : 'in'} ${extraClass}`;
        
        // Показываем имя отправителя в группе, если это не я
        let senderLabel = '';
        if(activeChatType === 'group' && !isMine) {
            senderLabel = `<div style="font-size:10px; color:var(--blue); margin-bottom:2px;">${m.senderName || 'User'}</div>`;
        }

        div.innerHTML = `
            ${senderLabel}
            ${content}
            <div class="msg-meta">
                ${new Date(m.time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
            </div>
        `;
        
        if (isMine) {
            div.oncontextmenu = (e) => { e.preventDefault(); if(confirm('Удалить?')) deleteMessage(m.id); };
        }
        list.appendChild(div);
    });
    setTimeout(() => list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' }), 100);
}

async function sendMsg(payload = null) {
    if(!activeChat) return;
    const textInput = document.getElementById('msgInput');
    const text = textInput.value.trim();
    if(!text && !payload) return;

    // Базовый объект сообщения
    const msgData = {
        sender: state.profile.id,
        senderName: state.profile.name,
        content: payload ? payload.content : text,
        type: payload ? payload.type : 'text',
        time: Date.now()
    };

    // Разделяем: либо chatId (личка), либо groupId (группа)
    if (activeChatType === 'group') {
        msgData.groupId = activeChat;
        // Убеждаемся, что chatId не попадет в базу
        if (msgData.chatId) delete msgData.chatId;
    } else {
        msgData.chatId = getChatId(state.profile.id, activeChat);
        // Убеждаемся, что groupId не попадет в базу
        if (msgData.groupId) delete msgData.groupId;
    }

    try {
        await db.collection("messages").add(msgData);
        textInput.value = '';
        autoResize(textInput);
    } catch (e) {
        console.error("Ошибка при отправке:", e);
        showToast("Ошибка отправки. Проверьте консоль.");
    }
}

async function deleteMessage(msgId) {
    try { await db.collection("messages").doc(msgId).delete(); } catch(e){}
}

// === СПИСОК КОНТАКТОВ И ГРУПП ===
function renderContactList() {
    const list = document.getElementById('contactList');
    list.innerHTML = '';
    
    // 1. Сначала рисуем ГРУППЫ
    state.groups.forEach(g => {
        const div = document.createElement('div');
        div.className = `contact ${activeChat === g.id ? 'active' : ''}`;
        div.innerHTML = `
            <img src="${g.avatar}" class="avatar">
            <div class="contact-info" onclick="loadChat('${g.id}', 'group')">
                <div class="contact-name"><i class="fas fa-users" style="font-size:12px; margin-right:5px; color:var(--blue)"></i> ${g.name}</div>
                <div class="contact-last">Группа</div>
            </div>
        `;
        list.appendChild(div);
    });

    // 2. Потом контакты
    state.contacts.forEach(c => {
        const div = document.createElement('div');
        div.className = `contact ${activeChat === c.id ? 'active' : ''}`;
        div.innerHTML = `
            <img src="${c.avatar}" class="avatar" onclick="event.stopPropagation(); viewFullScreen('${c.avatar}')">
            <div class="contact-info" onclick="loadChat('${c.id}', 'user')">
                <div class="contact-name">${c.name}</div>
                <div class="contact-last">@${c.shortId}</div>
            </div>
            <div class="contact-opt-btn" onclick="event.stopPropagation(); openContactOptions('${c.id}')"><i class="fas fa-ellipsis-v"></i></div>
        `;
        list.appendChild(div);
    });
}

// === ДОБАВЛЕНИЕ КОНТАКТА ===
async function addContact() {
    const searchShortId = document.getElementById('addId').value.trim().toLowerCase();
    if(!searchShortId) return;
    if(searchShortId === state.profile.shortId) return showToast('Это ваш ID');
    
    try {
        const query = await db.collection("users").where("shortId", "==", searchShortId).get();
        if(!query.empty) {
            const userData = query.docs[0].data();
            const partnerId = userData.id;

            // Генерируем ID чата (сортируем ID, чтобы он был одинаковым для обоих)
            const chatId = getChatId(state.profile.id, partnerId);

            // Создаем (или обновляем) запись о чате в базе данных
            // Важно: записываем ID обоих участников в массив members
            await db.collection("chats").doc(chatId).set({
                type: 'private',
                members: [state.profile.id, partnerId],
                updatedAt: Date.now() 
            }, { merge: true });

            showToast("Контакт добавлен!");
            closeModals();
        } else {
            showToast("Пользователь не найден");
        }
    } catch (e) {
        console.error(e);
        showToast("Ошибка при добавлении");
    }
}


// === МЕДИА ===
async function toggleRecord(mode) {
    if(mediaRecorder) { mediaRecorder.stop(); return; }
    try {
        const constraints = mode === 'video_note' ? { audio: true, video: { facingMode: "user", aspectRatio: 1 } } : { audio: true };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        mediaRecorder = new MediaRecorder(stream);
        recordedChunks = [];
        mediaRecorder.ondataavailable = e => recordedChunks.push(e.data);
        mediaRecorder.onstop = () => {
            const blob = new Blob(recordedChunks, { type: mode === 'video_note' ? 'video/webm' : 'audio/webm' });
            const reader = new FileReader();
            reader.onload = () => sendMsg({ type: mode, content: reader.result });
            reader.readAsDataURL(blob);
            stream.getTracks().forEach(t => t.stop());
            mediaRecorder = null;
            document.getElementById(mode === 'video_note' ? 'videoBtn' : 'voiceBtn').classList.remove('rec');
        };
        mediaRecorder.start();
        document.getElementById(mode === 'video_note' ? 'videoBtn' : 'voiceBtn').classList.add('rec');
    } catch(e) { showToast('Нет доступа к микро/камере'); }
}

function sendFile(input) {
    const file = input.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = e => sendMsg({ type: file.type.startsWith('video') ? 'video' : 'image', content: e.target.result });
    reader.readAsDataURL(file);
}
async function inviteToGroup() {
    // Проверяем, что мы вообще в группе
    if (activeChatType !== 'group') return;

    const shortId = prompt("Введите короткий ID пользователя (например, max2024):");
    if (!shortId) return;

    try {
        // 1. Ищем пользователя в коллекции users
        const userQuery = await db.collection("users").where("shortId", "==", shortId.toLowerCase().trim()).get();
        
        if (userQuery.empty) {
            return showToast("Пользователь с таким ID не найден");
        }

        const newUser = userQuery.docs[0].data();
        const newUserId = newUser.id;

        // 2. Обновляем документ группы в Firestore
        await db.collection("groups").doc(activeChat).update({
            members: firebase.firestore.FieldValue.arrayUnion(newUserId)
        });

        showToast(`${newUser.name} добавлен в группу!`);
    } catch (e) {
        console.error("Ошибка при добавлении:", e);
        showToast("Не удалось добавить участника. Возможно, у вас нет прав.");
    }
}

// === UI UTILS ===
function updateSelfUI() {
    document.getElementById('myNameDisplay').innerText = state.profile.name;
    document.getElementById('myIdDisplay').innerText = '@' + state.profile.shortId;
    document.getElementById('myAvatarDisplay').src = state.profile.avatar;
    document.getElementById('setMyName').value = state.profile.name;
    document.getElementById('setMyAvatar').value = state.profile.avatar;
}
function saveSettings() {
    state.profile.name = document.getElementById('setMyName').value;
    state.profile.avatar = document.getElementById('setMyAvatar').value;
    db.collection("users").doc(state.profile.id).set(state.profile, {merge:true});
    updateSelfUI(); closeModals();
}
function checkUrlParams() {
    const p = new URLSearchParams(window.location.search);
    const chat = p.get('chat');
    if(chat) { /* Логика диплинка */ }
}
function toggleFabMenu() { document.getElementById('fabMenu').classList.toggle('open'); }
function setRandomAvatar(inId, imgId) { const u = `https://picsum.photos/id/${Math.floor(Math.random()*1000)}/200`; document.getElementById(inId).value=u; if(imgId)document.getElementById(imgId).src=u; }
function updatePreview(id, v) { document.getElementById(id).src = v || 'https://ui-avatars.com/api/?name=?'; }
function openSettings() { openModal('modalSettings'); }
function openContactOptions(id) {
    if(!id) return;
    optionsTargetId = id;
    
    const optName = document.getElementById('optName');
    const modal = document.getElementById('modalOptions');
    
    // Очищаем старые кнопки "добавить", если они были (чтобы не дублировались)
    const oldBtn = document.getElementById('tempAddBtn');
    if(oldBtn) oldBtn.remove();

    if (activeChatType === 'group') {
        const grp = state.groups.find(g => g.id === id);
        optName.innerText = grp ? grp.name : 'Настройки группы';
        
        // Создаем кнопку "Добавить участника" динамически
        const addBtn = document.createElement('button');
        addBtn.id = 'tempAddBtn';
        addBtn.className = 'modal-btn primary';
        addBtn.style.marginBottom = '10px';
        addBtn.innerText = '➕ Добавить участника';
        addBtn.onclick = () => { closeModals(); inviteToGroup(); };
        
        // Вставляем кнопку перед кнопкой "Отмена"
        modal.querySelector('.modal').insertBefore(addBtn, modal.querySelector('.modal-btn.sec'));
    } else {
        const c = state.contacts.find(x => x.id === id);
        optName.innerText = c ? c.name : 'Опции';
    }
    
    openModal('modalOptions');
}

function deleteContactFromOptions() { 
    state.contacts = state.contacts.filter(c => c.id !== optionsTargetId); 
    localStorage.setItem('nx3_contacts', JSON.stringify(state.contacts)); 
    closeChat(); closeModals(); 
}
function viewAvatarFromOptions() { 
    const c = state.contacts.find(x => x.id === optionsTargetId); 
    if(c) viewFullScreen(c.avatar); closeModals(); 
}
function viewFullScreen(src) { document.getElementById('lightboxImg').src=src; document.getElementById('lightbox').classList.add('open'); document.getElementById('lightbox').style.display='flex'; }
function closeLightbox() { document.getElementById('lightbox').classList.remove('open'); setTimeout(()=>document.getElementById('lightbox').style.display='none',300); }
function autoResize(el) { el.style.height='auto'; el.style.height=el.scrollHeight+'px'; }
function openModal(id) { document.getElementById(id).style.display='flex'; setTimeout(()=>document.getElementById(id).classList.add('open'),10); }
function closeModals() { document.querySelectorAll('.modal-overlay').forEach(m=>{ m.classList.remove('open'); setTimeout(()=>m.style.display='none',300); }); }
function closeChat() { document.getElementById('chatWrap').classList.remove('active'); document.getElementById('sidebar').classList.remove('hidden'); if(currentUnsubscribe)currentUnsubscribe(); activeChat=null; renderContactList(); }
function showToast(m) { const t=document.getElementById('toast'); t.innerText=m; t.style.opacity=1; setTimeout(()=>t.style.opacity=0,2500); }
function copyMyId() { navigator.clipboard.writeText(state.profile.shortId); showToast('ID скопирован'); }

document.querySelectorAll('.modal-overlay').forEach(el => { el.addEventListener('click', e => { if(e.target===el && el.id!=='modalWelcome') closeModals(); }); });
