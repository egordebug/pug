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
    contacts: JSON.parse(localStorage.getItem('nx3_contacts')) || [],
    groups: [] // Сюда будем грузить группы из базы
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
                    listenToGroups(user.uid);
                    
                    // 3. Рендерим контакты
                    renderContactList();
                    
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

// === ГРУППЫ: Логика ===

// Слушаем изменения в коллекциях групп, где есть мой ID
function listenToGroups(myUid) {
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
}

function openCreateGroupModal() {
    // Генерируем список друзей для выбора
    const list = document.getElementById('groupUserList');
    list.innerHTML = '';
    
    if(state.contacts.length === 0) {
        list.innerHTML = '<div style="padding:10px; text-align:center; opacity:0.5;">Нет контактов</div>';
        return;
    }

    state.contacts.forEach(c => {
        const div = document.createElement('div');
        div.className = 'user-select-item';
        div.innerHTML = `
            <input type="checkbox" value="${c.id}" id="chk_${c.id}">
            <img src="${c.avatar}" style="width:30px; height:30px; border-radius:50%">
            <label for="chk_${c.id}" style="flex:1; cursor:pointer">${c.name}</label>
        `;
        list.appendChild(div);
    });
    
    openModal('modalCreateGroup');
}

async function finishCreateGroup() {
    const name = document.getElementById('newGroupName').value.trim();
    if(!name) return showToast('Введите название');
    
    // Собираем выбранных участников
    const checkboxes = document.querySelectorAll('#groupUserList input[type="checkbox"]:checked');
    const memberIds = Array.from(checkboxes).map(cb => cb.value);
    
    // Добавляем себя
    const finalMembers = [...new Set([state.profile.id, ...memberIds])];
    
    try {
        await db.collection("groups").add({
            name: name,
            members: finalMembers,
            admin: state.profile.id,
            avatar: `https://ui-avatars.com/api/?name=${name}&background=random`,
            createdAt: Date.now()
        });
        showToast('Группа создана!');
        closeModals();
    } catch(e) {
        console.error(e);
        showToast('Ошибка создания группы');
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
    
    if (currentUnsubscribe) currentUnsubscribe();

    // Формируем запрос
    let query = db.collection("messages").orderBy("time", "asc");

    if (type === 'group') {
        // Для групп ищем по groupId
        query = query.where("groupId", "==", targetId);
    } else {
        // Для лички по chatId
        const combinedId = getChatId(state.profile.id, targetId);
        query = query.where("chatId", "==", combinedId);
    }

    currentUnsubscribe = query.onSnapshot((snapshot) => {
        const msgs = [];
        snapshot.forEach(doc => msgs.push({ id: doc.id, ...doc.data() }));
        renderMessages(msgs);
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

    const msgData = {
        sender: state.profile.id,
        senderName: state.profile.name,
        content: payload ? payload.content : text,
        type: payload ? payload.type : 'text',
        time: Date.now()
    };

    // ВАЖНО: Разделяем логику для Групп и Лички
    if (activeChatType === 'group') {
        msgData.groupId = activeChat; // Для Rules groups
    } else {
        msgData.chatId = getChatId(state.profile.id, activeChat); // Для Rules direct
    }

    try {
        await db.collection("messages").add(msgData);
        textInput.value = '';
        autoResize(textInput);
    } catch (e) {
        console.error(e);
        showToast("Ошибка отправки (проверь права)");
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
    
    const query = await db.collection("users").where("shortId", "==", searchShortId).get();
    if(!query.empty) {
        const userData = query.docs[0].data();
        if(!state.contacts.find(c => c.id === userData.id)) {
            state.contacts.push(userData);
            localStorage.setItem('nx3_contacts', JSON.stringify(state.contacts));
            renderContactList();
        }
        closeModals();
        loadChat(userData.id, 'user');
    } else {
        showToast("Не найден");
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
function openContactOptions(id) { if(!id || activeChatType==='group')return; optionsTargetId=id; openModal('modalOptions'); }
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
