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
// === СОСТОЯНИЕ ===
let state = {
    profile: { name: '', id: '', shortId: '', avatar: '' },
    contacts: [], 
    groups: [] 
};

let activeChat = null; 
let activeChatType = null; 
let optionsTargetId = null;
let mediaRecorder = null;
let recordedChunks = [];
let currentUnsubscribe = null;
let groupsUnsubscribe = null; // Оставляем ОДИН РАЗ тут
let chatsUnsubscribe = null;  // Добавляем сюда


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
                    initPush(user.uid); 
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
async function listenToData(myUid) {
    // 1. ГРУППЫ
    if (groupsUnsubscribe) groupsUnsubscribe();
    groupsUnsubscribe = db.collection("groups")
        .where("members", "array-contains", myUid)
        .onSnapshot(snapshot => {
            state.groups = snapshot.docs.map(doc => ({ 
                id: doc.id, 
                ...doc.data(), 
                type: 'group' 
            })).sort((a, b) => (b.lastMsgTime || 0) - (a.lastMsgTime || 0));
            renderContactList();
        });

    // 2. ЛИЧНЫЕ ЧАТЫ
    if (chatsUnsubscribe) chatsUnsubscribe();
    chatsUnsubscribe = db.collection("chats")
        .where("members", "array-contains", myUid)
        .onSnapshot(async (snapshot) => {
            const chatMetaMap = {}; // Тут храним время прочтения и время чата
            const partnerIds = snapshot.docs.map(doc => {
                const data = doc.data();
                const partnerId = data.members.find(id => id !== myUid);
                if (partnerId) {
                    chatMetaMap[partnerId] = {
                        lastMsgTime: data.lastMsgTime || 0,
                        lastRead: data.lastRead || {}, // Содержит время прочтения всех участников
                        typing: data.typing || {}
                    };
                }
                return partnerId;
            }).filter(id => id);

            if (partnerIds.length === 0) {
                state.contacts = [];
                renderContactList();
                return;
            }

            // Слушаем профили партнеров
            db.collection("users").where("id", "in", partnerIds.slice(0, 30))
                .onSnapshot(userSnap => {
                    state.contacts = userSnap.docs.map(d => {
                        const userData = d.data();
                        return {
                            ...userData,
                            ...chatMetaMap[userData.id] // Подмешиваем данные чата к юзеру
                        };
                    });

                    state.contacts.sort((a, b) => (b.lastMsgTime || 0) - (a.lastMsgTime || 0));
                    renderContactList();
                    
                    // ВАЖНО: Если открыт чат, перерисовываем сообщения, чтобы галочки стали синими
                    if (activeChat && activeChatType === 'user') {
                        const currentPartner = state.contacts.find(c => c.id === activeChat);
                        if (currentPartner) {
                            // Если есть сохраненные сообщения в памяти или Firestore их обновит,
                            // renderMessages подхватит новый partnerLastRead
                            const msgsDiv = document.getElementById('messages');
                            if(msgsDiv.innerHTML !== "") {
                                // Этот вызов спровоцирует перерисовку галочек, так как данные в state.contacts обновились
                                // Если у тебя есть глобальная переменная с текущими сообщениями, вызови renderMessages(currentMessages);
                            }
                        }
                    }
                });
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
function formatLastSeen(timestamp) {
    if (!timestamp) return "давно";
    const now = Date.now();
    const diff = now - timestamp;

    if (diff < 60000) return "только что";
    if (diff < 3600000) return Math.floor(diff / 60000) + " мин. назад";
    
    const date = new Date(timestamp);
    if (diff < 86400000) {
        return "сегодня в " + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString();
}
// === ЧАТ ===
function getChatId(user1, user2) {
    return [user1, user2].sort().join('_');
}

async function loadChat(targetId, type = 'user') {
    activeChat = targetId;
    activeChatType = type;
    
    // 1. Очистка интерфейса перед загрузкой
    const list = document.getElementById('messages');
    list.innerHTML = '<div style="text-align:center; padding:20px; opacity:0.5;">Загрузка...</div>';
    
    // UI переключение (для мобилок)
    document.getElementById('chatWrap').classList.add('active');
    document.getElementById('sidebar').classList.add('hidden');
    
    let name, avatar;
    const statusEl = document.getElementById('chatStatus');
    statusEl.style.color = ""; // Сброс цвета (отменяем зеленый "печатает")

    // 2. Определяем данные чата (Группа или Юзер)
    if (type === 'group') {
        const grp = state.groups.find(g => g.id === targetId);
        name = grp ? grp.name : 'Группа';
        avatar = grp ? grp.avatar : '';
        statusEl.innerText = `${grp ? grp.members.length : 0} участников`;
    } else {
        const usr = state.contacts.find(c => c.id === targetId);
        name = usr ? usr.name : 'User';
        avatar = usr ? usr.avatar : '';
        
        if (usr && usr.lastSeen) {
            const isOnline = (Date.now() - usr.lastSeen) < 120000;
            statusEl.innerText = isOnline ? 'В сети' : "Был(а) в сети: " + formatLastSeen(usr.lastSeen);
        } else {
            statusEl.innerText = 'Оффлайн';
        }
    }

    document.getElementById('chatName').innerText = name;
    document.getElementById('chatAvatar').src = avatar;
    
    // 3. Отписываемся от старых слушателей (сообщения и статус)
    if (currentUnsubscribe) currentUnsubscribe();

    // 4. СЛУШАЕМ СООБЩЕНИЯ
    let msgQuery = db.collection("messages");
    if (type === 'group') {
        msgQuery = msgQuery.where("groupId", "==", targetId);
    } else {
        const combinedId = getChatId(state.profile.id, targetId);
        msgQuery = msgQuery.where("chatId", "==", combinedId);
    }

    currentUnsubscribe = msgQuery.orderBy("time", "asc").onSnapshot((snapshot) => {
        const msgs = [];
        snapshot.forEach(doc => msgs.push({ id: doc.id, ...doc.data() }));
        renderMessages(msgs);
    }, (err) => console.error("Ошибка сообщений:", err));

    // 5. СЛУШАЕМ СТАТУС "ПЕЧАТАЕТ..."
    const typingPath = type === 'group' ? 'groups' : 'chats';
    const typingId = type === 'group' ? targetId : getChatId(state.profile.id, targetId);

    // Дополнительная подписка на сам документ чата/группы
    db.collection(typingPath).doc(typingId).onSnapshot(doc => {
        if (!doc.exists) return;
        const data = doc.data();
        
        // Сброс счетчика непрочитанных для меня при входе
        if (data.lastMsgTime) {
            db.collection(typingPath).doc(typingId).update({
                [`lastRead.${state.profile.id}`]: Date.now()
            }).catch(()=>{});
        }

        // Логика отображения "Печатает..." - ОТКЛЮЧЕНА
        // const typingData = data.typing || {};
        // const typers = Object.keys(typingData).filter(uid => typingData[uid] === true && uid !== state.profile.id);

        // if (typers.length > 0) {
        //     statusEl.innerText = type === 'group' ? "Кто-то печатает..." : "Печатает...";
        //     statusEl.style.color = "#00ff00";
        // } else {
        statusEl.style.color = "";
        // Возвращаем исходный статус
        if (type === 'group') {
            statusEl.innerText = `${data.members ? data.members.length : 0} участников`;
        } else {
            // Для лички берем актуальный lastSeen партнера
            const partner = state.contacts.find(c => c.id === targetId);
            if (partner) {
                const isOnline = (Date.now() - partner.lastSeen) < 120000;
                statusEl.innerText = isOnline ? 'В сети' : "Был(а) в сети: " + formatLastSeen(partner.lastSeen);
            }
        }
        // }
    });
}



async function renderMessages(msgs) {
		const container = document.getElementById('messages');
		if (!container) return;
		container.innerHTML = '';

		msgs.forEach(m => {
				const isMine = m.sender === state.profile.id;
				const msgDiv = document.createElement('div');
				
				// Классы для своих и чужих
				const hasCircle = m.type === 'video_note' ? 'has-circle' : '';
				msgDiv.className = `msg ${isMine ? 'out' : 'in'} ${hasCircle}`;
				msgDiv.id = `msg-${m.id}`;

				// --- 1. ТЕКСТ ИЛИ МЕДИА ---
				let bodyHtml = '';
				if (m.type === 'image') {
						bodyHtml = `<img src="${m.content}" onclick="viewFullScreen('${m.content}')">`;
				} else if (m.type === 'video_note') {
						bodyHtml = `<video class="circle-msg" src="${m.content}" autoplay loop muted playsinline onclick="this.muted = !this.muted"></video>`;
				} else if (m.type === 'audio') {
						bodyHtml = `<audio src="${m.content}" controls></audio>`;
				} else {
						// ВАЖНО: используем m.content, так как в sendMsg ты шлешь именно его
						const text = m.content || m.text || ''; 
						bodyHtml = text ? `<span>${text}</span>` : '';
				}

				// --- 2. РЕАКЦИИ ---
				let reactionsHtml = '<div class="reaction-container">';
				if (m.reactions) {
						for (const [emoji, users] of Object.entries(m.reactions)) {
								if (users && users.length > 0) {
										const activeClass = users.includes(state.profile.id) ? 'active' : '';
										reactionsHtml += `
												<div class="reaction-badge ${activeClass}" onclick="toggleReaction('${m.id}', '${emoji}')">
														${emoji} <span>${users.length}</span>
												</div>`;
								}
						}
				}

				// Плюсик ТОЛЬКО для чужих сообщений
				if (!isMine) {
						reactionsHtml += `
								<div class="add-reaction" onclick="showReactionMenu(event, '${m.id}')">
										<i class="far fa-smile"></i>
								</div>`;
				}
				reactionsHtml += '</div>';

				// --- 3. ВРЕМЯ И СТАТУС ---
				const time = m.time ? new Date(m.time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '';
				const statusIcon = isMine ? (m.read ? '<i class="fas fa-check-double"></i>' : '<i class="fas fa-check"></i>') : '';
				
				const metaHtml = `
						<div class="msg-meta">
								${time} ${statusIcon}
						</div>`;

				// Сборка всего воедино
				msgDiv.innerHTML = bodyHtml + reactionsHtml + metaHtml;
				container.appendChild(msgDiv);
		});

		container.scrollTop = container.scrollHeight;
}

async function sendMsg(payload = null) {
    if(!activeChat) return;
    const textInput = document.getElementById('msgInput');
    const text = textInput.value.trim();
    if(!text && !payload) return;

    // Проверка на размер (если это Base64)
    if (payload && payload.content && payload.content.length > 1000000) {
        return showToast("Файл слишком большой! Попробуй другое фото.");
    }

    const now = Date.now();
    const msgData = {
        sender: state.profile.id,
        senderName: state.profile.name,
        content: payload ? payload.content : text,
        type: payload ? payload.type : 'text',
        time: now
    };

    activeChatType === 'group' ? msgData.groupId = activeChat : msgData.chatId = getChatId(state.profile.id, activeChat);

    // Очищаем поле СРАЗУ (для скорости UI)
    textInput.value = '';
    autoResize(textInput);

    try {
        await db.collection("messages").add(msgData);

        const chatPath = activeChatType === 'group' ? 'groups' : 'chats';
        const chatDocId = activeChatType === 'group' ? activeChat : getChatId(state.profile.id, activeChat);

        await db.collection(chatPath).doc(chatDocId).update({
            lastMsgTime: now,
            [`typing.${state.profile.id}`]: false 
        });
    } catch (e) {
        console.error(e);
        showToast("Ошибка. Возможно, файл слишком тяжелый.");
        // Если ошибка — возвращаем текст обратно, чтобы не потерять
        if(!payload) textInput.value = text; 
    }
}


// === СПИСОК КОНТАКТОВ И ГРУПП ===
function renderContactList() {
    const list = document.getElementById('contactList');
    list.innerHTML = '';
    
    // Объединяем группы и контакты для удобства рендеринга
    const allChats = [
        ...state.groups.map(g => ({ ...g, isGroup: true })),
        ...state.contacts.filter(c => c.id !== state.profile.id).map(c => ({ ...c, isGroup: false }))
    ];

    allChats.forEach(item => {
        const isGroup = item.isGroup;
        const id = item.id;
        
        // --- ЛОГИКА ТОЧКИ ---
        // Получаем документ чата/группы, чтобы вытащить время
        const chatId = isGroup ? id : getChatId(state.profile.id, id);
        
        // ВАЖНО: Мы будем искать данные о времени в state.groups или доп. массиве.
        // Но проще всего проверить наличие непрочитанных, если эти данные приходят из Snapshot
        // Допустим, мы храним время последнего захода в item.lastRead
        const lastMsgTime = item.lastMsgTime || 0;
        const myLastRead = (item.lastRead && item.lastRead[state.profile.id]) ? item.lastRead[state.profile.id] : 0;
        
        // Если последнее сообщение новее, чем наше время прочтения — рисуем точку
        const hasUnread = lastMsgTime > myLastRead && activeChat !== id;

        const isOnline = !isGroup && item.lastSeen && (Date.now() - item.lastSeen) < 120000;

        const div = document.createElement('div');
        div.className = `contact ${activeChat === id ? 'active' : ''}`;
        div.style.position = 'relative'; // Нужно для позиционирования точки

        let statusHtml = '';
        if (isGroup) {
            statusHtml = `<span style="opacity: 0.7;">Группа: ${item.members.length} уч.</span>`;
        } else {
            statusHtml = isOnline 
                ? `<span style="color: #00ff00; font-weight: bold;">В сети</span>`
                : `<span style="opacity: 0.6;">Был(а): ${formatLastSeen(item.lastSeen)}</span>`;
        }

        div.innerHTML = `
            <div style="position: relative;">
                <img src="${item.avatar}" class="avatar" onclick="event.stopPropagation(); viewFullScreen('${item.avatar}')">
                ${isOnline ? '<div style="position:absolute; bottom:2px; right:2px; width:12px; height:12px; background:#00ff00; border:2px solid var(--bg); border-radius:50%;"></div>' : ''}
            </div>
            <div class="contact-info" onclick="loadChat('${id}', '${isGroup ? 'group' : 'user'}')">
                <div class="contact-name">
                    ${isGroup ? '<i class="fas fa-users" style="font-size:12px; margin-right:5px; color:var(--blue)"></i>' : ''}
                    ${item.name}
                </div>
                <div class="contact-last">${statusHtml}</div>
            </div>
            ${hasUnread ? '<div class="unread-dot"></div>' : ''}
            <div class="contact-opt-btn" onclick="event.stopPropagation(); openContactOptions('${id}')">
                <i class="fas fa-ellipsis-v"></i>
            </div>
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
async function checkUrlParams() {
    const p = new URLSearchParams(window.location.search);
    const inviteGroupId = p.get('invite');

    if (inviteGroupId && state.profile.id) {
        try {
            const groupDoc = await db.collection("groups").doc(inviteGroupId).get();
            if (!groupDoc.exists) return showToast("Группа не найдена");

            const groupData = groupDoc.data();
            if (groupData.members.includes(state.profile.id)) {
                loadChat(inviteGroupId, 'group');
            } else {
                if (confirm(`Вступить в группу "${groupData.name}"?`)) {
                    await db.collection("groups").doc(inviteGroupId).update({
                        members: firebase.firestore.FieldValue.arrayUnion(state.profile.id)
                    });
                    showToast("Вы вступили!");
                    loadChat(inviteGroupId, 'group');
                }
            }
            // Убираем параметр из строки адреса, чтобы не спрашивало при перезагрузке
            window.history.replaceState({}, document.title, window.location.pathname);
        } catch (e) { console.error(e); }
    }
}
const messaging = firebase.messaging();
const VAPID_KEY = 'yTpqd1mewy_D9gxuByV8o4SwJqz38qSk8RLcZWJPgNs';

// 2. Твоя функция (добавил параметр uid для надежности)
// Добавь (uid) в скобки
async function initPush(uid) { 
    try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            const token = await messaging.getToken({ vapidKey: VAPID_KEY });
            
            if (token) {
                // Используем переданный uid, чтобы точно попасть в нужный документ
                await db.collection("users").doc(uid).update({
                    fcmToken: token
                });
                console.log("FCM Токен сохранен для:", uid);
            }
        }
    } catch (err) {
        console.error('Ошибка пушей:', err);
    }
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
    
    // Чистим старые динамические кнопки
    document.querySelectorAll('.temp-btn').forEach(b => b.remove());

    if (activeChatType === 'group') {
        const grp = state.groups.find(g => g.id === id);
        optName.innerText = grp ? grp.name : 'Настройки группы';
        
        // Кнопка ДОБАВИТЬ по ID
        const addBtn = document.createElement('button');
        addBtn.className = 'modal-btn primary temp-btn';
        addBtn.style.marginBottom = '10px';
        addBtn.innerText = '➕ Добавить участника';
        addBtn.onclick = () => { closeModals(); inviteToGroup(); };
        
        // Кнопка КОПИРОВАТЬ ССЫЛКУ
        const linkBtn = document.createElement('button');
        linkBtn.className = 'modal-btn sec temp-btn';
        linkBtn.style.marginBottom = '10px';
        linkBtn.innerHTML = '<i class="fas fa-link"></i> Ссылка-инвайт';
        linkBtn.onclick = () => {
            const link = window.location.origin + window.location.pathname + '?invite=' + id;
            navigator.clipboard.writeText(link);
            showToast("Ссылка скопирована!");
            closeModals();
        };
        
        modal.querySelector('.modal').insertBefore(addBtn, modal.querySelector('.modal-btn.sec'));
        modal.querySelector('.modal').insertBefore(linkBtn, modal.querySelector('.modal-btn.sec'));
    } else {
        const c = state.contacts.find(x => x.id === id);
        optName.innerText = c ? c.name : 'Опции';
    }
    
    openModal('modalOptions');
}
function autoResize(el) {
    el.style.height = 'auto';
    const newHeight = el.scrollHeight;
    // Ограничиваем рост до 120px
    el.style.height = (newHeight > 120 ? 120 : newHeight) + 'px';
}


async function deleteMessage(msgId) {
    try { await db.collection("messages").doc(msgId).delete(); } catch(e){}
}

// Замени эту функцию:
async function deleteContactFromOptions() { 
    if(!confirm('Удалить этот чат для вас? (Внимание: это удалит запись о контакте в базе)')) return;
    
    try {
        if (activeChatType === 'user') {
            const chatId = getChatId(state.profile.id, optionsTargetId);
            await db.collection("chats").doc(chatId).delete();
            showToast("Чат удален");
        } else {
            // Если это группа — просто выходим из неё
            await db.collection("groups").doc(optionsTargetId).update({
                members: firebase.firestore.FieldValue.arrayRemove(state.profile.id)
            });
            showToast("Вы вышли из группы");
        }
        closeChat(); 
        closeModals();
    } catch(e) {
        showToast("Ошибка при удалении");
    }
}

async function compressImage(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                // Ограничиваем максимальную сторону 1200px
                const MAX_SIZE = 1200;
                if (width > height && width > MAX_SIZE) {
                    height *= MAX_SIZE / width;
                    width = MAX_SIZE;
                } else if (height > MAX_SIZE) {
                    width *= MAX_SIZE / height;
                    height = MAX_SIZE;
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                // Качество 0.7 (70%) — идеальный баланс
                const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
                resolve(dataUrl);
            };
        };
    });
}

// Обнови свою функцию sendFile
async function sendFile(input) {
    const file = input.files[0];
    if (!file) return;

    if (file.type.startsWith('image')) {
        showToast("Сжатие...");
        const compressedBase64 = await compressImage(file);
        sendMsg({ type: 'image', content: compressedBase64 });
    } else {
        // Для видео оставляем как есть (или в будущем через Storage)
        const reader = new FileReader();
        reader.onload = e => sendMsg({ type: 'video', content: e.target.result });
        reader.readAsDataURL(file);
    }
}

let typingTimeout;
function setTypingStatus() {
    if (!activeChat) return;

    const collection = activeChatType === 'group' ? 'groups' : 'chats';
    const docId = activeChatType === 'group' ? activeChat : getChatId(state.profile.id, activeChat);

    // Устанавливаем статус "печатает"
    db.collection(collection).doc(docId).update({
        [`typing.${state.profile.id}`]: true
    });

    // Сбрасываем через 3 секунды неактивности
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        db.collection(collection).doc(docId).update({
            [`typing.${state.profile.id}`]: false
        });
    }, 3000);
}

// Добавь обработчик на поле ввода в HTML:
// 


function viewAvatarFromOptions() { 
    const c = state.contacts.find(x => x.id === optionsTargetId); 
    if(c) viewFullScreen(c.avatar); closeModals(); 
}
function viewFullScreen(src) { document.getElementById('lightboxImg').src=src; document.getElementById('lightbox').classList.add('open'); document.getElementById('lightbox').style.display='flex'; }
function closeLightbox() { document.getElementById('lightbox').classList.remove('open'); setTimeout(()=>document.getElementById('lightbox').style.display='none',300); }
function openModal(id) { document.getElementById(id).style.display='flex'; setTimeout(()=>document.getElementById(id).classList.add('open'),10); }
// Функция добавления/удаления реакции
async function toggleReaction(msgId, emoji) {
		const myId = state.profile.id;
		// Важно: сообщения у тебя в корневой коллекции messages
		const msgRef = db.collection('messages').doc(msgId);

		try {
				const doc = await msgRef.get();
				if (!doc.exists) return;

				let reactions = doc.data().reactions || {};
				if (!reactions[emoji]) reactions[emoji] = [];

				if (reactions[emoji].includes(myId)) {
						// Убираем реакцию
						reactions[emoji] = reactions[emoji].filter(id => id !== myId);
						if (reactions[emoji].length === 0) delete reactions[emoji];
				} else {
						// Добавляем реакцию
						reactions[emoji].push(myId);
				}

				await msgRef.update({ reactions });
		} catch (e) {
				console.error("Ошибка реакции:", e);
				showToast("Не удалось поставить реакцию");
		}
}

// Быстрое меню реакций (всплывашка)
async function showReactionMenu(e, msgId) {
		e.stopPropagation();
		// Удаляем старое меню, если оно есть
		const oldMenu = document.querySelector('.quick-reaction-menu');
		if (oldMenu) oldMenu.remove();

		const menu = document.createElement('div');
		menu.className = 'quick-reaction-menu';
		
		const emojis = ['👍', '❤️', '😂', '😮', '😡', '🙏'];
		emojis.forEach(emoji => {
				const span = document.createElement('span');
				span.innerText = emoji;
				span.onclick = () => {
						toggleReaction(msgId, emoji);
						menu.remove();
				};
				menu.appendChild(span);
		});

		// Позиционируем меню рядом с кликом
		menu.style.top = `${e.clientY - 50}px`;
		menu.style.left = `${e.clientX}px`;

		document.body.appendChild(menu);

		// Закрытие меню при клике в любое другое место
		setTimeout(() => {
				document.addEventListener('click', () => menu.remove(), { once: true });
		}, 10);
}


function closeModals() { document.querySelectorAll('.modal-overlay').forEach(m=>{ m.classList.remove('open'); setTimeout(()=>m.style.display='none',300); }); }
async function closeChat() { document.getElementById('chatWrap').classList.remove('active'); document.getElementById('sidebar').classList.remove('hidden'); if(currentUnsubscribe)currentUnsubscribe(); activeChat=null; renderContactList(); }
function showToast(m) { const t=document.getElementById('toast'); t.innerText=m; t.style.opacity=1; setTimeout(()=>t.style.opacity=0,2500); }
async function copyMyId() { navigator.clipboard.writeText(state.profile.shortId); showToast('ID скопирован'); }

// Переключение видимости пикера (исправлено)
function toggleEmojiPicker(e) {
		if (e) e.stopPropagation(); // Чтобы клик по кнопке не закрывал пикер сразу
		const picker = document.getElementById('emojiPickerContainer');
		const isHidden = picker.style.display === 'none' || picker.style.display === '';
		picker.style.display = isHidden ? 'block' : 'none';

		if (isHidden) {
				// Закрытие при клике мимо
				const closeHandler = (event) => {
						if (!picker.contains(event.target) && !event.target.closest('.btn-icon')) {
								picker.style.display = 'none';
								document.removeEventListener('click', closeHandler);
						}
				};
				document.addEventListener('click', closeHandler);
		}
}

// Обработка выбора эмодзи (с учетом позиции курсора)
document.querySelector('emoji-picker').addEventListener('emoji-click', event => {
		const input = document.getElementById('msgInput');
		const start = input.selectionStart;
		const end = input.selectionEnd;
		const emoji = event.detail.unicode;

		// Вставляем там, где моргает палочка
		input.value = input.value.substring(0, start) + emoji + input.value.substring(end);
		
		// Возвращаем фокус и ставим курсор ПОСЛЕ смайлика
		input.focus();
		input.selectionStart = input.selectionEnd = start + emoji.length;
		
		autoResize(input);
});


document.querySelectorAll('.modal-overlay').forEach(el => { el.addEventListener('click', e => { if(e.target===el && el.id!=='modalWelcome') closeModals(); }); });
// Каждую минуту отправляем в базу, что мы еще тут
setInterval(() => {
    if (state.profile.id) {
        db.collection("users").doc(state.profile.id).update({
            lastSeen: Date.now()
        }).catch(() => {});
    }
}, 60000);

// Каждую минуту обновляем текст в интерфейсе (чтобы "5 мин. назад" менялось на "6 мин. назад")
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        const height = window.visualViewport.height;
        // Ограничиваем высоту всего body высотой видимой области
        document.body.style.height = height + 'px';
        // Прокручиваем сообщения вниз, чтобы видеть последнее
        const list = document.getElementById('messages');
        list.scrollTop = list.scrollHeight;
    });
}

setInterval(() => {
    renderContactList();
    if (activeChat && activeChatType === 'user') {
        const currentPartner = state.contacts.find(c => c.id === activeChat);
        if (currentPartner) {
            const statusEl = document.getElementById('chatStatus');
            const isOnline = (Date.now() - currentPartner.lastSeen) < 120000;
            statusEl.innerText = isOnline ? 'В сети' : "Был(а) в сети: " + formatLastSeen(currentPartner.lastSeen);
        }
    }
}, 60000);
