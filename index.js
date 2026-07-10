const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const BOT_VERSION = "v1.7.0";

// --- PostgreSQL ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
});
const sql = (query, params) => pool.query(query, params);

// --- In-memory кэш (write-through) ---
const db = {
    users: {}, // сессии — только в памяти, не нужно хранить
    reports: {},
    defenders: {},
    banned: {},
    ticketCounter: 0,
};

// Статистика считается из db.reports динамически
const getStats = () => {
    const vals = Object.values(db.reports);
    return {
        accepted: vals.filter((r) => r.status === "accepted").length,
        declined: vals.filter((r) => r.status === "declined").length,
    };
};

// --- Загрузка данных из БД при старте ---
async function dbLoad() {
    const [reports, defenders, banned, config] = await Promise.all([
        sql("SELECT * FROM reports"),
        sql("SELECT * FROM defenders"),
        sql("SELECT user_id FROM banned_users"),
        sql("SELECT value FROM config WHERE key = 'ticket_counter'"),
    ]);

    for (const r of reports.rows) {
        db.reports[r.user_id] = {
            ticket: r.ticket,
            status: r.status,
            priority: r.priority,
            data: {
                region: r.region,
                type: r.type,
                description: r.description,
            },
            username: r.username,
            createdAt: Number(r.created_at),
            readAt: r.read_at ? Number(r.read_at) : null,
            reminded: r.reminded,
        };
    }

    for (const d of defenders.rows) {
        db.defenders[d.user_id] = {
            status: d.status,
            username: d.username,
            data: {
                region: d.region,
                nickname: d.nickname,
                specialty: d.specialty,
                experience: d.experience,
                motivation: d.motivation,
                quizScore: d.quiz_score,
                quizTotal: d.quiz_total,
            },
        };
    }

    for (const b of banned.rows) {
        db.banned[b.user_id] = true;
    }

    db.ticketCounter = parseInt(config.rows[0]?.value || "0");
    console.log(
        `БД загружена: ${reports.rows.length} репортов, ${defenders.rows.length} защитников, ${banned.rows.length} банов`,
    );
}

// --- Хелперы записи (обновляют и память, и БД) ---
async function nextTicket() {
    db.ticketCounter++;
    await sql("UPDATE config SET value = $1 WHERE key = 'ticket_counter'", [
        String(db.ticketCounter),
    ]);
    return String(db.ticketCounter).padStart(4, "0");
}

async function saveReport(userId, data) {
    db.reports[userId] = data;
    await sql(
        `
        INSERT INTO reports (user_id, ticket, status, priority, region, type, description, username, created_at, read_at, reminded)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (user_id) DO UPDATE SET
            ticket=$2, status=$3, priority=$4, region=$5, type=$6,
            description=$7, username=$8, created_at=$9, read_at=$10, reminded=$11
    `,
        [
            userId,
            data.ticket,
            data.status,
            data.priority,
            data.data.region,
            data.data.type,
            data.data.description,
            data.username,
            data.createdAt,
            data.readAt,
            data.reminded,
        ],
    );
}

async function updateReportStatus(userId, status) {
    if (!db.reports[userId]) return;
    db.reports[userId].status = status;
    await sql("UPDATE reports SET status=$1 WHERE user_id=$2", [
        status,
        userId,
    ]);
}

async function updateReportReadAt(userId) {
    if (!db.reports[userId]) return;
    const now = Date.now();
    db.reports[userId].readAt = now;
    await sql("UPDATE reports SET read_at=$1 WHERE user_id=$2", [now, userId]);
}

async function updateReportReminded(userId) {
    if (!db.reports[userId]) return;
    db.reports[userId].reminded = true;
    await sql("UPDATE reports SET reminded=true WHERE user_id=$1", [userId]);
}

async function saveDefender(userId, data) {
    db.defenders[userId] = data;
    await sql(
        `
        INSERT INTO defenders (user_id, status, username, region, nickname, specialty, experience, motivation, quiz_score, quiz_total)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (user_id) DO UPDATE SET
            status=$2, username=$3, region=$4, nickname=$5, specialty=$6,
            experience=$7, motivation=$8, quiz_score=$9, quiz_total=$10
    `,
        [
            userId,
            data.status,
            data.username,
            data.data.region,
            data.data.nickname,
            data.data.specialty,
            data.data.experience,
            data.data.motivation,
            data.data.quizScore ?? null,
            data.data.quizTotal ?? null,
        ],
    );
}

async function updateDefenderStatus(userId, status) {
    if (!db.defenders[userId]) return;
    db.defenders[userId].status = status;
    await sql("UPDATE defenders SET status=$1 WHERE user_id=$2", [
        status,
        userId,
    ]);
}

async function banUser(userId) {
    db.banned[userId] = true;
    await sql(
        "INSERT INTO banned_users (user_id) VALUES ($1) ON CONFLICT DO NOTHING",
        [userId],
    );
}

async function unbanUser(userId) {
    delete db.banned[userId];
    await sql("DELETE FROM banned_users WHERE user_id=$1", [userId]);
}

// --- Экранирование MarkdownV2 ---
const esc = (s) => String(s).replace(/[_*[\]()~`>#+=|{}.!\-]/g, "\\$&");

// --- Роли ---
const isAdmin = (ctx) =>
    String(ctx.from.id) === String(ADMIN_CHAT_ID) ||
    String(ctx.chat?.id) === String(ADMIN_CHAT_ID);

const isDefender = (userId) => db.defenders[userId]?.status === "accepted";
const canModerateReports = (ctx) => isAdmin(ctx) || isDefender(ctx.from.id);

// --- OSINT КВИЗ ---
const QUIZ = [
    {
        q: "Что такое OSINT?",
        options: [
            "Сбор данных из открытых источников",
            "Взлом закрытых систем",
            "Перехват зашифрованного трафика",
            "Физическая слежка за объектом",
        ],
        correct: 0,
    },
    {
        q: "Что изучает GEOINT?",
        options: [
            "Финансовые потоки",
            "Геопространственные данные и снимки",
            "Агентурные источники",
            "Радиоперехват",
        ],
        correct: 1,
    },
    {
        q: "HUMINT — это разведка через:",
        options: [
            "Спутниковые снимки",
            "Открытые интернет-источники",
            "Живых людей-агентов",
            "Технические сигналы",
        ],
        correct: 2,
    },
    {
        q: "Какой инструмент используют для анализа метаданных изображений?",
        options: ["Nmap", "Wireshark", "ExifTool", "Shodan"],
        correct: 2,
    },
    {
        q: "SIGINT — это разведка на основе:",
        options: [
            "Аэрофотоснимков",
            "Сигналов и перехвата связи",
            "Публичных социальных сетей",
            "Агентурных источников",
        ],
        correct: 1,
    },
    {
        q: "Какой из сайтов является поисковиком по IP-адресам и устройствам в интернете?",
        options: ["DuckDuckGo", "Archive.org", "Shodan", "Pastebin"],
        correct: 2,
    },
    {
        q: "Как называется архив веб-страниц, где можно найти удалённый контент?",
        options: ["Wayback Machine", "DeepL", "VirusTotal", "Maltego"],
        correct: 0,
    },
    {
        q: "Что такое доксинг (doxing)?",
        options: [
            "Шифрование переписки",
            "Сбор и публикация личных данных человека без его согласия",
            "Анализ сетевого трафика",
            "Взлом аккаунтов в соцсетях",
        ],
        correct: 1,
    },
    {
        q: "Какой инструмент позволяет строить граф связей между людьми и организациями?",
        options: ["Nmap", "Maltego", "Burp Suite", "Aircrack-ng"],
        correct: 1,
    },
    {
        q: "Что можно узнать по WHOIS-запросу домена?",
        options: [
            "Пароль от сайта",
            "Данные о регистраторе и владельце домена",
            "Список всех посетителей сайта",
            "Исходный код страницы",
        ],
        correct: 1,
    },
    {
        q: "Reverse image search (обратный поиск по картинке) помогает:",
        options: [
            "Улучшить качество фото",
            "Найти источник изображения и похожие снимки",
            "Удалить фото из интернета",
            "Зашифровать изображение",
        ],
        correct: 1,
    },
    {
        q: "Какой тип данных чаще всего используется при геолокации фото по открытым источникам?",
        options: [
            "Метаданные (GPS в EXIF)",
            "Цвет пикселей",
            "Размер файла",
            "Формат сжатия",
        ],
        correct: 0,
    },
];
const QUIZ_MIN_SCORE = 7;

const sendQuizQuestion = async (ctx, userId) => {
    const session = db.users[userId];
    const idx = session.data.quizQuestion;
    const q = QUIZ[idx];
    const letters = ["A", "B", "C", "D"];
    await ctx.reply(
        `🧠 Вопрос ${idx + 1}/${QUIZ.length}\n\n${q.q}`,
        Markup.inlineKeyboard(
            q.options.map((opt, i) => [
                Markup.button.callback(
                    `${letters[i]}) ${opt}`,
                    `quiz_${idx}_${i}`,
                ),
            ]),
        ),
    );
};

// --- Клавиатуры ---
const getMainMenuKeyboard = (userId) => {
    const buttons = [
        [Markup.button.callback("🛡️ Стать защитником", "cmd_join")],
        [Markup.button.callback("🆘 Запросить помощь", "cmd_report")],
        [Markup.button.callback("📊 Статус моей заявки", "cmd_status")],
        [Markup.button.callback("ℹ️ Справка", "cmd_help")],
    ];
    if (isDefender(userId)) {
        buttons.splice(2, 0, [
            Markup.button.callback("📋 Заявки на помощь", "def_list_reports"),
        ]);
    }
    return Markup.inlineKeyboard(buttons);
};
const getBackMenuKeyboard = () =>
    Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Вернуться в меню", "cmd_menu")],
    ]);

const resetState = (userId) => {
    if (db.users[userId]) {
        db.users[userId].state = null;
        db.users[userId].step = null;
    }
};

// --- Приветствие ---
const sendWelcome = async (ctx) => {
    resetState(ctx.from.id);
    await ctx.replyWithMarkdownV2(
        `🛡 *Bakelite Defence*\n\n` +
            `Наша цель проста — помогать людям, столкнувшимся с киберпреступностью, и собирать вокруг этого сильную команду специалистов\\.\n\n` +
            `Здесь вы можете:\n` +
            `— подать заявку и стать частью команды\n` +
            `— сообщить об инциденте и получить помощь\n` +
            `— отследить статус своего обращения\n\n` +
            `🏆 лучший проект @kartochniy\n` +
            `🔖 Версия: \`${BOT_VERSION}\`\n` +
            `🐛 Сообщить об ошибке: @kartochniy\n\n` +
            `Выберите действие:`,
        getMainMenuKeyboard(ctx.from.id),
    );
};
bot.start(sendWelcome);
bot.action("cmd_menu", sendWelcome);
bot.command("menu", sendWelcome);

// --- Справка ---
const sendHelp = async (ctx) => {
    const extra = isDefender(ctx.from.id)
        ? `\n/requests — Список активных заявок на помощь \\(для защитников\\)`
        : "";
    await ctx.replyWithMarkdownV2(
        `📌 *Справка по командам бота:*\n\n` +
            `/start \\| /menu — Главное меню системы\n` +
            `/join — Подать заявку в команду защитников \\(OSINT\\)\n` +
            `/report — Сообщить о киберпреступлении и получить помощь\n` +
            `/status — Проверить статус ваших обращений и общую статистику${extra}`,
        getBackMenuKeyboard(),
    );
};
bot.command("help", sendHelp);
bot.action("cmd_help", sendHelp);

// --- Статус ---
const sendStatus = async (ctx) => {
    const userId = ctx.from.id;
    const userReport = db.reports[userId];
    const stats = getStats();

    let reportStatusText = "У вас нет активных заявок на помощь\\.";
    if (userReport) {
        let statusEmoji = "⏳",
            statusString = "Под рассмотрением";
        if (userReport.status === "accepted") {
            statusEmoji = "✅";
            statusString = "Принята в работу";
        }
        if (userReport.status === "declined") {
            statusEmoji = "❌";
            statusString = "Отклонена";
        }
        const ticket = userReport.ticket
            ? ` \\(Тикет \\#${userReport.ticket}\\)`
            : "";
        reportStatusText = `Статус вашей заявки${ticket}: ${statusEmoji} *${statusString}*`;
    }

    await ctx.replyWithMarkdownV2(
        `📊 *Статистика системы:*\n` +
            `• Принято заявок в работу: ${stats.accepted}\n` +
            `• Отклонено заявок: ${stats.declined}\n\n` +
            `🔍 *Ваш статус:*\n${reportStatusText}\n\n` +
            `_Примечание: При завершении работы по заявке, защитник свяжется с вами напрямую в ЛС\\._`,
        getBackMenuKeyboard(),
    );
};
bot.command("status", sendStatus);
bot.action("cmd_status", sendStatus);

// --- Вступление в защитники ---
bot.command("join", async (ctx) => {
    ctx.reply("Нажимайте кнопку в меню для запуска процесса.");
});

bot.action("cmd_join", async (ctx) => {
    const userId = ctx.from.id;
    if (db.banned[userId]) return ctx.reply("🚫 Вы заблокированы в системе.");
    db.users[userId] = { state: "JOIN_FLOW", step: "SELECT_REGION", data: {} };
    await ctx.reply(
        "Шаг 1: Выберите ваш регион деятельности:",
        Markup.inlineKeyboard([
            [
                Markup.button.callback("Россия", "join_reg_RU"),
                Markup.button.callback("Украина", "join_reg_UA"),
            ],
            [
                Markup.button.callback("Казахстан", "join_reg_KZ"),
                Markup.button.callback("Другое", "join_reg_OTHER"),
            ],
            [Markup.button.callback("⬅️ Отмена", "cmd_menu")],
        ]),
    );
});

bot.action(/^join_reg_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    if (!db.users[userId] || db.users[userId].state !== "JOIN_FLOW")
        return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const regions = {
        RU: "Россия",
        UA: "Украина",
        KZ: "Казахстан",
        OTHER: "Другой регион",
    };
    db.users[userId].data.region = regions[ctx.match[1]];
    db.users[userId].step = "INPUT_NICKNAME";
    await ctx.reply(
        "Шаг 2 из 5: Введите ваш рабочий псевдоним (никнейм) для системы:",
    );
});

// --- Репорт ---
bot.command("report", async (ctx) => {
    ctx.reply("Пожалуйста, используйте меню бота для отправки репорта.");
});

bot.action("cmd_report", async (ctx) => {
    const userId = ctx.from.id;
    if (db.banned[userId]) return ctx.reply("🚫 Вы заблокированы в системе.");
    db.users[userId] = {
        state: "REPORT_FLOW",
        step: "SELECT_REGION",
        data: {},
    };
    await ctx.reply(
        "Шаг 1: В какой стране/регионе произошел инцидент?",
        Markup.inlineKeyboard([
            [
                Markup.button.callback("Россия", "rep_reg_RU"),
                Markup.button.callback("Украина", "rep_reg_UA"),
            ],
            [
                Markup.button.callback("Казахстан", "rep_reg_KZ"),
                Markup.button.callback("Другое", "rep_reg_OTHER"),
            ],
            [Markup.button.callback("⬅️ Отмена", "cmd_menu")],
        ]),
    );
});

bot.action(/^rep_reg_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    if (!db.users[userId] || db.users[userId].state !== "REPORT_FLOW")
        return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    if (ctx.match[1] === "OTHER") {
        db.users[userId].step = "INPUT_OTHER_REGION";
        await ctx.reply("Напишите, в какой стране произошел инцидент:");
    } else {
        const regions = { RU: "Россия", UA: "Украина", KZ: "Казахстан" };
        db.users[userId].data.region = regions[ctx.match[1]];
        goToReportType(ctx, userId);
    }
});

const goToReportType = async (ctx, userId) => {
    db.users[userId].step = "SELECT_TYPE";
    await ctx.reply(
        "Шаг 2: Выберите вид киберпреступности:",
        Markup.inlineKeyboard([
            [
                Markup.button.callback("Вымогательство", "rep_type_1"),
                Markup.button.callback("Кибербуллинг", "rep_type_2"),
            ],
            [
                Markup.button.callback("Мошенничество", "rep_type_3"),
                Markup.button.callback("Другое", "rep_type_OTHER"),
            ],
            [Markup.button.callback("⬅️ Отмена", "cmd_menu")],
        ]),
    );
};

bot.action(/^rep_type_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    if (!db.users[userId] || db.users[userId].state !== "REPORT_FLOW")
        return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    if (ctx.match[1] === "OTHER") {
        db.users[userId].step = "INPUT_OTHER_TYPE";
        await ctx.reply("Укажите ваш вид киберпреступности:");
    } else {
        const types = {
            1: "Вымогательство",
            2: "Кибербуллинг",
            3: "Мошенничество",
        };
        db.users[userId].data.type = types[ctx.match[1]];
        goToPriority(ctx, userId);
    }
});

const goToPriority = async (ctx, userId) => {
    db.users[userId].step = "SELECT_PRIORITY";
    await ctx.reply(
        "Шаг 3: Укажите срочность вашего обращения:",
        Markup.inlineKeyboard([
            [Markup.button.callback("🔴 Срочно", "rep_priority_high")],
            [Markup.button.callback("🟡 Средне", "rep_priority_med")],
            [Markup.button.callback("🟢 Не срочно", "rep_priority_low")],
            [Markup.button.callback("⬅️ Отмена", "cmd_menu")],
        ]),
    );
};

bot.action(/^rep_priority_(high|med|low)$/, async (ctx) => {
    const userId = ctx.from.id;
    if (!db.users[userId] || db.users[userId].state !== "REPORT_FLOW")
        return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const map = { high: "🔴 Срочно", med: "🟡 Средне", low: "🟢 Не срочно" };
    db.users[userId].data.priority = map[ctx.match[1]];
    db.users[userId].step = "INPUT_DESCRIPTION";
    await ctx.reply(
        "Шаг 4: Предоставьте подробное описание проблемы (ссылки, детали, суть обмана):",
    );
});

// --- Текстовый менеджер ---
// ВАЖНО: этот обработчик ловит ЛЮБОЕ текстовое сообщение, включая команды (/admin, /requests и т.д.).
// Если сообщение сюда не подходит — обязательно вызываем next(), иначе Telegraf не дойдёт до
// bot.command(...), зарегистрированных ниже по файлу, и они "не будут работать".
bot.on("text", async (ctx, next) => {
    const userId = ctx.from.id;
    const text = ctx.message.text;

    // Любую слэш-команду, которую этот блок не обрабатывает сам, пропускаем дальше по цепочке
    const isHandledHere =
        isAdmin(ctx) &&
        (text.startsWith("/ban ") ||
            text.startsWith("/unban ") ||
            text.startsWith("/reply "));
    if (text.startsWith("/") && !isHandledHere) {
        return next();
    }

    if (isAdmin(ctx)) {
        if (text.startsWith("/ban ")) {
            const targetId = text.split(" ")[1]?.trim();
            if (!targetId) return ctx.reply("Использование: /ban <user_id>");
            await banUser(targetId);
            return ctx.reply(`🚫 Пользователь ${targetId} заблокирован.`);
        }
        if (text.startsWith("/unban ")) {
            const targetId = text.split(" ")[1]?.trim();
            if (!targetId) return ctx.reply("Использование: /unban <user_id>");
            await unbanUser(targetId);
            return ctx.reply(`✅ Пользователь ${targetId} разблокирован.`);
        }
        if (text.startsWith("/reply ")) {
            const parts = text.split(" ");
            const targetId = parts[1]?.trim();
            const message = parts.slice(2).join(" ").trim();
            if (!targetId || !message)
                return ctx.reply("Использование: /reply <user_id> <текст>");
            try {
                await bot.telegram.sendMessage(
                    targetId,
                    `📨 *Сообщение от специалиста Bakelite Defence:*\n\n${message}`,
                    { parse_mode: "Markdown" },
                );
                return ctx.reply(
                    `✅ Сообщение отправлено пользователю ${targetId}.`,
                );
            } catch (e) {
                return ctx.reply(`❌ Не удалось отправить: ${e.message}`);
            }
        }
    }

    const userSession = db.users[userId];
    if (!userSession) return next();

    if (userSession.state === "JOIN_FLOW") {
        if (userSession.step === "INPUT_NICKNAME") {
            userSession.data.nickname = text;
            userSession.step = "INPUT_SPECIALTY";
            await ctx.reply(
                "Шаг 3 из 5: Укажите вашу специальность / роль в сфере IT или OSINT:\n(например: OSINT-аналитик, пентестер, системный администратор)",
            );
            return;
        }
        if (userSession.step === "INPUT_SPECIALTY") {
            userSession.data.specialty = text;
            userSession.step = "QUIZ";
            userSession.data.quizQuestion = 0;
            userSession.data.quizScore = 0;
            await ctx.reply(
                `📋 Анкета заполнена. Теперь небольшой тест — ${QUIZ.length} вопросов по теории разведки.\nМинимальный проходной балл: ${QUIZ_MIN_SCORE}/${QUIZ.length}.\n\nНачинаем! 👇`,
            );
            await sendQuizQuestion(ctx, userId);
            return;
        }
        if (userSession.step === "INPUT_EXPERIENCE") {
            userSession.data.experience = text;
            userSession.step = "INPUT_MOTIVATION";
            await ctx.reply(
                "Шаг 5 из 5: Расскажите о себе и мотивации:\n— Почему хотите вступить в Bakelite Defence?\n— Чем готовы помочь команде?",
            );
            return;
        }
        if (userSession.step === "INPUT_MOTIVATION") {
            userSession.data.motivation = text;
            userSession.step = "CONFIRM";
            await ctx.replyWithMarkdownV2(
                `📋 *Резюме кандидата:*\n\n` +
                    `👤 *Псевдоним:* ${esc(userSession.data.nickname)}\n` +
                    `🌍 *Регион:* ${esc(userSession.data.region)}\n` +
                    `🔧 *Специальность:* ${esc(userSession.data.specialty)}\n\n` +
                    `📁 *Опыт работы:*\n${esc(userSession.data.experience)}\n\n` +
                    `💬 *Мотивация:*\n${esc(userSession.data.motivation)}`,
                Markup.inlineKeyboard([
                    [
                        Markup.button.callback(
                            "✅ Отправить заявку",
                            "join_confirm_send",
                        ),
                    ],
                    [Markup.button.callback("❌ Отменить", "cmd_menu")],
                ]),
            );
            return;
        }
    }

    if (userSession.state === "REPORT_FLOW") {
        if (userSession.step === "INPUT_OTHER_REGION") {
            userSession.data.region = text;
            goToReportType(ctx, userId);
            return;
        }
        if (userSession.step === "INPUT_OTHER_TYPE") {
            userSession.data.type = text;
            goToPriority(ctx, userId);
            return;
        }
        if (userSession.step === "INPUT_DESCRIPTION") {
            userSession.data.description = text;
            userSession.step = "CONFIRM";
            await ctx.replyWithMarkdownV2(
                `🚨 *Проверка репорта перед отправкой:*\n\n` +
                    `• Регион инцидента: ${esc(userSession.data.region)}\n` +
                    `• Вид нарушения: ${esc(userSession.data.type)}\n` +
                    `• Приоритет: ${esc(userSession.data.priority || "🟡 Средне")}\n` +
                    `• Описание: ${esc(userSession.data.description)}`,
                Markup.inlineKeyboard([
                    [
                        Markup.button.callback(
                            "✅ Всё верно, отправить",
                            "rep_confirm_send",
                        ),
                    ],
                    [Markup.button.callback("❌ Отменить", "cmd_menu")],
                ]),
            );
            return;
        }
    }
});

// --- Подтверждение заявки защитника ---
bot.action("join_confirm_send", async (ctx) => {
    const userId = ctx.from.id;
    const userSession = db.users[userId];
    if (!userSession || userSession.state !== "JOIN_FLOW")
        return ctx.answerCbQuery();
    await ctx.answerCbQuery();

    const defenderData = {
        status: "pending",
        username: ctx.from.username || "нету",
        data: userSession.data,
    };
    await saveDefender(userId, defenderData);
    await ctx.reply(
        "🚀 Ваша заявка успешно отправлена администрации проекта! Ожидайте верификации.",
        getBackMenuKeyboard(),
    );

    if (ADMIN_CHAT_ID) {
        const quizScore = userSession.data.quizScore ?? "?";
        const quizLabel = quizScore >= QUIZ_MIN_SCORE ? "✅" : "❌";
        await bot.telegram.sendMessage(
            ADMIN_CHAT_ID,
            `🔔 *НОВАЯ ЗАЯВКА НА ВСТУПЛЕНИЕ \\(Защитник\\)*\n\n` +
                `👤 *От:* [Ссылка](tg://user?id=${userId}) \\(ID: \`${userId}\`, @${esc(ctx.from.username || "нет")}\\)\n` +
                `🌍 *Регион:* ${esc(userSession.data.region)}\n` +
                `🏷 *Псевдоним:* ${esc(userSession.data.nickname)}\n` +
                `🔧 *Специальность:* ${esc(userSession.data.specialty)}\n` +
                `📝 *Тест:* ${quizLabel} ${quizScore} из ${QUIZ.length}\n\n` +
                `📁 *Опыт работы:*\n${esc(userSession.data.experience)}\n\n` +
                `💬 *Мотивация:*\n${esc(userSession.data.motivation)}`,
            {
                parse_mode: "MarkdownV2",
                ...Markup.inlineKeyboard([
                    [
                        Markup.button.callback(
                            "👍 Одобрить",
                            `adm_join_accept_${userId}`,
                        ),
                        Markup.button.callback(
                            "👎 Отклонить",
                            `adm_join_decline_${userId}`,
                        ),
                    ],
                ]),
            },
        );
    }
    resetState(userId);
});

// --- Подтверждение репорта ---
bot.action("rep_confirm_send", async (ctx) => {
    const userId = ctx.from.id;
    const userSession = db.users[userId];
    if (!userSession || userSession.state !== "REPORT_FLOW")
        return ctx.answerCbQuery();
    await ctx.answerCbQuery();

    const ticket = await nextTicket();
    const reportData = {
        ticket,
        status: "pending",
        priority: userSession.data.priority || "🟡 Средне",
        data: userSession.data,
        username: ctx.from.username || null,
        createdAt: Date.now(),
        readAt: null,
        reminded: false,
    };
    await saveReport(userId, reportData);

    await ctx.reply(
        `✅ Ваш запрос зарегистрирован в системе.\n\n🎫 Номер тикета: *#${ticket}*\n\nКогда специалист возьмёт его в работу — вы получите уведомление.`,
        { parse_mode: "Markdown", ...getBackMenuKeyboard() },
    );

    if (ADMIN_CHAT_ID) {
        await bot.telegram.sendMessage(
            ADMIN_CHAT_ID,
            `🚨 *НОВЫЙ ЗАПРОС О ПОМОЩИ \\#${ticket}*\n\n` +
                `• Приоритет: ${esc(reportData.priority)}\n` +
                `• ID пострадавшего: \`${userId}\`\n` +
                `• Регион: ${esc(userSession.data.region)}\n` +
                `• Тип киберпреступления: ${esc(userSession.data.type)}\n` +
                `• Описание: ${esc(userSession.data.description)}`,
            {
                parse_mode: "MarkdownV2",
                ...Markup.inlineKeyboard([
                    [
                        Markup.button.callback(
                            "👁 Прочитано — уведомить жертву",
                            `def_rep_read_${userId}`,
                        ),
                    ],
                    [
                        Markup.button.callback(
                            "⚡ Взять в работу",
                            `def_rep_take_${userId}`,
                        ),
                    ],
                    [
                        Markup.button.callback(
                            "❌ Отклонить репорт",
                            `def_rep_deny_${userId}`,
                        ),
                    ],
                ]),
            },
        );
    }

    // Рассылка активным защитникам о новом обращении
    const defenderIds = Object.entries(db.defenders)
        .filter(([, d]) => d.status === "accepted")
        .map(([uid]) => uid)
        .filter((uid) => String(uid) !== String(ADMIN_CHAT_ID));

    for (const defId of defenderIds) {
        try {
            await bot.telegram.sendMessage(
                defId,
                `🚨 *НОВЫЙ ЗАПРОС О ПОМОЩИ \\#${ticket}*\n\n` +
                    `• Приоритет: ${esc(reportData.priority)}\n` +
                    `• Регион: ${esc(userSession.data.region)}\n` +
                    `• Тип киберпреступления: ${esc(userSession.data.type)}\n` +
                    `• Описание: ${esc(userSession.data.description)}`,
                {
                    parse_mode: "MarkdownV2",
                    ...Markup.inlineKeyboard([
                        [
                            Markup.button.callback(
                                "👁 Прочитано — уведомить жертву",
                                `def_rep_read_${userId}`,
                            ),
                        ],
                        [
                            Markup.button.callback(
                                "⚡ Взять в работу",
                                `def_rep_take_${userId}`,
                            ),
                        ],
                        [
                            Markup.button.callback(
                                "❌ Отклонить репорт",
                                `def_rep_deny_${userId}`,
                            ),
                        ],
                    ]),
                },
            );
        } catch (e) {
            console.error(
                `Не удалось уведомить защитника ${defId}:`,
                e.message,
            );
        }
    }

    resetState(userId);
});

// --- Модерация защитников ---
bot.action(/^adm_join_accept_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("⛔ Нет доступа");
    await ctx.answerCbQuery("✅ Одобрено");
    const targetUserId = ctx.match[1];
    await updateDefenderStatus(targetUserId, "accepted");
    try {
        await ctx.editMessageText(
            `${ctx.callbackQuery.message.text}\n\n🟢 Статус: ОДОБРЕН`,
        );
    } catch {}
    try {
        await bot.telegram.sendMessage(
            targetUserId,
            `🎉 Поздравляем! Ваша заявка одобрена. Добро пожаловать в команду Bakelite Defence!\n\nТеперь в главном меню (/menu) вам доступен раздел «📋 Заявки на помощь» — там видны все активные обращения.`,
        );
    } catch (e) {
        console.error("Уведомление:", e.message);
    }
});

bot.action(/^adm_join_decline_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("⛔ Нет доступа");
    await ctx.answerCbQuery("❌ Отклонено");
    const targetUserId = ctx.match[1];
    await updateDefenderStatus(targetUserId, "declined");
    try {
        await ctx.editMessageText(
            `${ctx.callbackQuery.message.text}\n\n🔴 Статус: ОТКЛОНЕН`,
        );
    } catch {}
    try {
        await bot.telegram.sendMessage(
            targetUserId,
            `❌ К сожалению, ваша заявка на вступление отклонена модератором.`,
        );
    } catch (e) {
        console.error("Уведомление:", e.message);
    }
});

// --- Список заявок для защитников (и админа) ---
const sendDefenderReportsList = async (ctx) => {
    if (!canModerateReports(ctx))
        return ctx.reply(
            "⛔ Этот раздел доступен только одобренным защитникам.",
        );
    const entries = Object.entries(db.reports).filter(
        ([, r]) => r.status === "pending",
    );
    if (entries.length === 0)
        return ctx.reply(
            "✅ Активных заявок сейчас нет.",
            getBackMenuKeyboard(),
        );

    await ctx.reply(`🆘 Активные заявки (${entries.length}):`);
    for (const [uid, r] of entries) {
        const uname = r.username ? `@${esc(r.username)}` : `ID: ${uid}`;
        const ticket = r.ticket ? ` \\[\\#${r.ticket}\\]` : "";
        const readStatus = r.readAt
            ? "👁 Уже прочитано"
            : "🆕 Ещё не прочитано";
        const buttons = [];
        if (!r.readAt)
            buttons.push([
                Markup.button.callback(
                    "👁 Прочитано — уведомить жертву",
                    `def_rep_read_${uid}`,
                ),
            ]);
        buttons.push([
            Markup.button.callback("⚡ Взять в работу", `def_rep_take_${uid}`),
        ]);
        buttons.push([
            Markup.button.callback(
                "❌ Отклонить репорт",
                `def_rep_deny_${uid}`,
            ),
        ]);

        await ctx.replyWithMarkdownV2(
            `🚨 *Заявка${ticket}*\n\n` +
                `• Приоритет: ${esc(r.priority || "🟡 Средне")}\n` +
                `• От: ${uname}\n` +
                `• Регион: ${esc(r.data.region || "—")}\n` +
                `• Тип: ${esc(r.data.type || "—")}\n` +
                `• Описание: ${esc(r.data.description || "—")}\n` +
                `• ${readStatus}`,
            Markup.inlineKeyboard(buttons),
        );
    }
    await ctx.reply(
        "⬆️ Это все активные заявки на текущий момент.",
        getBackMenuKeyboard(),
    );
};

bot.command("requests", sendDefenderReportsList);
bot.action("def_list_reports", async (ctx) => {
    await ctx.answerCbQuery();
    await sendDefenderReportsList(ctx);
});

// --- Работа с репортами (доступно админу и одобренным защитникам) ---
bot.action(/^def_rep_read_(.+)$/, async (ctx) => {
    if (!canModerateReports(ctx)) return ctx.answerCbQuery("⛔ Нет доступа");
    const targetUserId = ctx.match[1];
    const reader = ctx.from.username ? `@${ctx.from.username}` : `специалист`;
    await updateReportReadAt(targetUserId);
    await ctx.answerCbQuery("Жертва уведомлена ✅");
    try {
        await ctx.editMessageText(
            `${ctx.callbackQuery.message.text}\n\n👁 Прочитано: ${reader}`,
            Markup.inlineKeyboard([
                [
                    Markup.button.callback(
                        "⚡ Взять в работу",
                        `def_rep_take_${targetUserId}`,
                    ),
                ],
                [
                    Markup.button.callback(
                        "❌ Отклонить репорт",
                        `def_rep_deny_${targetUserId}`,
                    ),
                ],
            ]),
        );
    } catch {}
    try {
        await bot.telegram.sendMessage(
            targetUserId,
            `👁 Ваше обращение прочитано специалистом.\n\nС вами свяжутся в ближайшее время в личные сообщения — будьте на связи.`,
        );
    } catch (e) {
        console.error(`Уведомление ${targetUserId}:`, e.message);
    }
});

bot.action(/^def_rep_take_(.+)$/, async (ctx) => {
    if (!canModerateReports(ctx)) return ctx.answerCbQuery("⛔ Нет доступа");
    const targetUserId = ctx.match[1];
    if (db.reports[targetUserId]?.status !== "pending") {
        return ctx.answerCbQuery("⚠️ Заявка уже обработана другим защитником", {
            show_alert: true,
        });
    }
    await ctx.answerCbQuery("⚡ Взято в работу");
    const defender = ctx.from.username
        ? `@${ctx.from.username}`
        : `ID:${ctx.from.id}`;
    await updateReportStatus(targetUserId, "accepted");
    try {
        await ctx.editMessageText(
            `${ctx.callbackQuery.message.text}\n\n⚡ Статус: ВЗЯТО В РАБОТУ (${defender})`,
        );
    } catch {}
    try {
        await bot.telegram.sendMessage(
            targetUserId,
            `✅ Ваш запрос взят в работу специалистом. Ожидайте сообщения в личные сообщения.`,
        );
    } catch (e) {
        console.error("Уведомление:", e.message);
    }
});

bot.action(/^def_rep_deny_(.+)$/, async (ctx) => {
    if (!canModerateReports(ctx)) return ctx.answerCbQuery("⛔ Нет доступа");
    const targetUserId = ctx.match[1];
    if (db.reports[targetUserId]?.status !== "pending") {
        return ctx.answerCbQuery("⚠️ Заявка уже обработана другим защитником", {
            show_alert: true,
        });
    }
    await ctx.answerCbQuery("❌ Отклонено");
    await updateReportStatus(targetUserId, "declined");
    try {
        await ctx.editMessageText(
            `${ctx.callbackQuery.message.text}\n\n❌ Статус: ОТКЛОНЕН`,
        );
    } catch {}
    try {
        await bot.telegram.sendMessage(
            targetUserId,
            `❌ К сожалению, ваш запрос о помощи был отклонён специалистом.`,
        );
    } catch (e) {
        console.error("Уведомление:", e.message);
    }
});

// --- OSINT квиз ---
bot.action(/^quiz_(\d+)_(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const session = db.users[userId];
    console.log(
        `[QUIZ] userId=${userId} data=${ctx.callbackQuery.data} session=${session ? `state=${session.state} step=${session.step}` : "NONE"}`,
    );
    if (!session || session.state !== "JOIN_FLOW" || session.step !== "QUIZ") {
        console.log(
            `[QUIZ] guard rejected: session=${!!session} state=${session?.state} step=${session?.step}`,
        );
        return ctx.answerCbQuery();
    }
    await ctx.answerCbQuery();

    const buttonQuestion = parseInt(ctx.match[1]);
    const answerIdx = parseInt(ctx.match[2]);
    const questionIdx = session.data.quizQuestion;
    if (buttonQuestion !== questionIdx) return;

    const correct = QUIZ[questionIdx].correct;
    const letters = ["A", "B", "C", "D"];

    if (answerIdx === correct) {
        session.data.quizScore++;
        await ctx.reply("✅ Верно!");
    } else {
        await ctx.reply(
            `❌ Неверно. Правильный ответ: ${letters[correct]}) ${QUIZ[questionIdx].options[correct]}`,
        );
    }

    session.data.quizQuestion++;

    if (session.data.quizQuestion >= QUIZ.length) {
        const score = session.data.quizScore;
        const total = QUIZ.length;
        if (score >= QUIZ_MIN_SCORE) {
            await ctx.reply(
                `🎯 Тест завершён. Результат: ${score}/${total} — пройден!\n\nПродолжаем заполнение анкеты.`,
            );
            session.step = "INPUT_EXPERIENCE";
            await ctx.reply(
                "Шаг 4 из 5: Опишите ваш опыт:\n— Сколько лет в сфере?\n— Над какими проектами / задачами работали?\n— Какие инструменты используете?",
            );
        } else {
            await ctx.reply(
                `🎯 Тест завершён. Результат: ${score}/${total} — не пройден.\n\n` +
                    `Минимальный проходной балл: ${QUIZ_MIN_SCORE}/${total}.\n` +
                    `Изучите материал и попробуйте снова позже.`,
                getBackMenuKeyboard(),
            );
            resetState(userId);
        }
    } else {
        await sendQuizQuestion(ctx, userId);
    }
});

// --- Админ панель ---
bot.command("admin", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const now = Date.now();
    const DAY = 86400000;
    const stats = getStats();
    const reports = Object.values(db.reports);
    const today = reports.filter((r) => now - r.createdAt < DAY).length;
    const week = reports.filter((r) => now - r.createdAt < 7 * DAY).length;
    const month = reports.filter((r) => now - r.createdAt < 30 * DAY).length;
    const pending = reports.filter((r) => r.status === "pending").length;

    await ctx.reply(
        `🔧 Админ-панель Bakelite Defence\n\n` +
            `👥 Защитников в базе: ${Object.keys(db.defenders).length}\n` +
            `🆘 Обращений всего: ${reports.length}\n` +
            `   ├ За сегодня: ${today}\n` +
            `   ├ За неделю: ${week}\n` +
            `   ├ За месяц: ${month}\n` +
            `   └ Ожидают ответа: ${pending}\n\n` +
            `✅ Принято в работу: ${stats.accepted}\n` +
            `❌ Отклонено: ${stats.declined}\n\n` +
            `📌 Команды:\n` +
            `/ban <id> — заблокировать пользователя\n` +
            `/unban <id> — разблокировать\n` +
            `/reply <id> <текст> — написать жертве анонимно`,
        Markup.inlineKeyboard([
            [
                Markup.button.callback(
                    "🛡️ Отдел «Защитники»",
                    "adm_department_defenders",
                ),
            ],
            [
                Markup.button.callback(
                    "📝 Все заявки на вступление",
                    "adm_list_defenders",
                ),
            ],
            [Markup.button.callback("🆘 Список обращений", "adm_list_reports")],
        ]),
    );
});

// --- Отдел «Защитники»: только принятые, с возможностью исключить ---
bot.action("adm_department_defenders", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    const entries = Object.entries(db.defenders).filter(
        ([, d]) => d.status === "accepted",
    );
    if (entries.length === 0)
        return ctx.reply("🛡️ В отделе «Защитники» пока никого нет.");

    await ctx.reply(`🛡️ *Отдел «Защитники»* — принято: ${entries.length}`, {
        parse_mode: "Markdown",
    });
    for (const [uid, d] of entries) {
        const uname =
            d.username && d.username !== "нету"
                ? `@${esc(d.username)}`
                : `ID: ${uid}`;
        const quiz =
            d.data.quizScore != null && d.data.quizTotal != null
                ? `${d.data.quizScore}/${d.data.quizTotal}`
                : "—";
        const text =
            `🛡 *${esc(d.data.nickname || "—")}* \\(${uname}, ID: \`${uid}\`\\)\n` +
            `🌍 Регион: ${esc(d.data.region || "—")}\n` +
            `🔧 Специальность: ${esc(d.data.specialty || "—")}\n` +
            `📝 Тест: ${esc(quiz)}\n` +
            `📁 Опыт: ${esc((d.data.experience || "—").slice(0, 150))}${(d.data.experience || "").length > 150 ? "\\.\\.\\." : ""}`;
        await ctx.replyWithMarkdownV2(
            text,
            Markup.inlineKeyboard([
                [
                    Markup.button.callback(
                        "❌ Исключить из отряда",
                        `adm_defender_kick_${uid}`,
                    ),
                ],
            ]),
        );
    }
    await ctx.reply("⬆️ Это все действующие защитники.", getBackMenuKeyboard());
});

bot.action(/^adm_defender_kick_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("⛔ Нет доступа");
    const targetUserId = ctx.match[1];
    await ctx.answerCbQuery("❌ Исключён");
    await updateDefenderStatus(targetUserId, "declined");
    try {
        await ctx.editMessageText(
            `${ctx.callbackQuery.message.text}\n\n🚫 ИСКЛЮЧЁН ИЗ ОТРЯДА`,
        );
    } catch {}
    try {
        await bot.telegram.sendMessage(
            targetUserId,
            `⚠️ Вы были исключены из команды Bakelite Defence администрацией.`,
        );
    } catch (e) {
        console.error("Уведомление:", e.message);
    }
});

bot.action("adm_list_defenders", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    const entries = Object.entries(db.defenders);
    if (entries.length === 0)
        return ctx.reply("Заявок на вступление пока нет.");
    const statusMap = {
        pending: "⏳ На рассмотрении",
        accepted: "✅ Одобрен",
        declined: "❌ Отклонён",
    };
    let text = `👥 *Все заявки на вступление \\(${entries.length}\\):*\n\n`;
    entries.forEach(([uid, d], i) => {
        const uname =
            d.username && d.username !== "нету"
                ? `@${esc(d.username)}`
                : `ID: ${uid}`;
        text += `*${i + 1}\\. ${esc(d.data.nickname || "—")}* \\(${uname}\\)\n`;
        text += `🌍 ${esc(d.data.region || "—")} \\| 🔧 ${esc(d.data.specialty || "—")}\n`;
        text += `📁 ${esc((d.data.experience || "—").slice(0, 80))}${(d.data.experience || "").length > 80 ? "\\.\\.\\." : ""}\n`;
        text += `${statusMap[d.status] || d.status}\n\n`;
    });
    await ctx.replyWithMarkdownV2(text);
});

bot.action("adm_list_reports", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.answerCbQuery();
    const entries = Object.entries(db.reports);
    if (entries.length === 0) return ctx.reply("Обращений пока нет.");
    const statusMap = {
        pending: "⏳ На рассмотрении",
        accepted: "⚡ В работе",
        declined: "❌ Отклонён",
    };
    let text = `🆘 *Обращения \\(${entries.length}\\):*\n\n`;
    entries.forEach(([uid, r], i) => {
        const uname = r.username ? `@${esc(r.username)}` : `ID: ${uid}`;
        const ticket = r.ticket ? ` \\[\\#${r.ticket}\\]` : "";
        text += `*${i + 1}\\. ${uname}${ticket}*\n`;
        text += `${esc(r.priority || "🟡 Средне")} \\| 🌍 ${esc(r.data.region || "—")} \\| 🔍 ${esc(r.data.type || "—")}\n`;
        text += `📝 ${esc((r.data.description || "—").slice(0, 100))}${(r.data.description || "").length > 100 ? "\\.\\.\\." : ""}\n`;
        text += `${statusMap[r.status] || r.status}\n\n`;
    });
    await ctx.replyWithMarkdownV2(text);
});

// --- Напоминание: репорты без ответа > 24 часов ---
setInterval(
    async () => {
        if (!ADMIN_CHAT_ID) return;
        const now = Date.now();
        const THRESHOLD = 24 * 60 * 60 * 1000;
        for (const [userId, report] of Object.entries(db.reports)) {
            if (
                report.status === "pending" &&
                !report.readAt &&
                !report.reminded &&
                now - report.createdAt > THRESHOLD
            ) {
                await updateReportReminded(userId);
                try {
                    await bot.telegram.sendMessage(
                        ADMIN_CHAT_ID,
                        `⏰ *Напоминание*\n\nРепорт \\#${report.ticket || userId} \\(ID: \`${userId}\`\\) ожидает ответа уже больше 24 часов\\.\nПриоритет: ${esc(report.priority || "—")}`,
                        { parse_mode: "MarkdownV2" },
                    );
                } catch (e) {
                    console.error("Ошибка напоминания:", e.message);
                }
            }
        }
    },
    60 * 60 * 1000,
);

// --- Глобальный обработчик ошибок ---
bot.catch((err, ctx) => {
    const desc = err?.response?.description || err?.message || String(err);
    if (
        desc.includes("query is too old") ||
        desc.includes("query ID is invalid")
    )
        return;
    console.error(`Ошибка бота (update ${ctx?.update?.update_id}):`, desc);
});

process.on("unhandledRejection", (reason) => {
    const msg = reason?.message || String(reason);
    if (msg.includes("query is too old") || msg.includes("query ID is invalid"))
        return;
    console.error("Unhandled rejection:", msg);
});

// --- Keep-alive ---
const http = require("http");
http.createServer((_, res) => {
    res.writeHead(200);
    res.end("ok");
}).listen(5000);

// --- Запуск: сначала грузим БД, потом стартуем бота ---
dbLoad()
    .then(() => bot.launch())
    .then(() => console.log("Бот запущен ✅"))
    .catch((err) => {
        console.error("Ошибка запуска:", err);
        process.exit(1);
    });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
