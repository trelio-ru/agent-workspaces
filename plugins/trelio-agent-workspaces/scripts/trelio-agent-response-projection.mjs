// Generated portable Trelio response contract. Do not edit by hand.
export const MCP_RESPONSE_PROJECTION_VERSION = 1;
export const MCP_RESPONSE_DETAIL_TOOLS = new Set([
    "get_contact", "get_registry", "get_knowledge_base_page", "get_project_meta",
    "get_task_create_meta", "list_recent_activity", "list_agent_skills",
]);
const record = (value) => (value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ? value : null);
const own = (value, key) => Object.hasOwn(value, key);
const mapArray = (value, project) => (Array.isArray(value) ? value.map(project) : value);
const mapFields = (value, fields) => {
    const source = record(value);
    if (!source)
        return value;
    const result = { ...source };
    for (const [key, project] of Object.entries(fields)) {
        if (own(source, key))
            result[key] = project(source[key]);
    }
    return result;
};
const list = (project) => (value) => mapArray(value, project);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
// Явный набор смысловых полей человека/группы. Если service добавит неизвестное
// поле, сохраняем весь объект: новый смысл нельзя потерять молча. Budget fixtures
// на настоящих builders заметят возврат оформления и потребуют классификации.
const PERSON_FIELDS = new Set([
    "id", "memberId", "userId", "groupId", "displayName", "userDisplayName",
    "displayNameOverride", "username", "name", "profileNote", "lastSeenAt",
    "companyRole", "projectRole", "role", "entityType", "memberCount",
    "isPlaceholder", "isActive", "availability", "permissions", "profilePath",
    "absence", "substitution", "status", "canSelect", "disabledReason",
    "avatarUrl", "initials", "color", "members",
]);
export const projectMcpPerson = (value) => {
    const person = record(value);
    if (!person || Object.keys(person).some((key) => !PERSON_FIELDS.has(key)))
        return value;
    const result = Object.fromEntries(Object.entries(person).filter(([key]) => (key !== "avatarUrl" && key !== "initials" && key !== "color")));
    // Effective name уже сформирован canonical member builder. Удалять отличающееся
    // исходное имя нельзя: оно может объяснять совпадение поиска или различать людей.
    // Null/false в профильных заметках, доступе и состоянии сохраняются буквально.
    for (const key of ["userDisplayName", "displayNameOverride"]) {
        if (typeof result.displayName === "string" && result[key] === result.displayName)
            delete result[key];
    }
    if (Array.isArray(result.members))
        result.members = result.members.map(projectMcpPerson);
    return result;
};
const person = projectMcpPerson;
const persons = list(person);
const control = (value) => mapFields(value, { createdBy: person });
const attachment = (value) => mapFields(value, { uploadedBy: person, deletedBy: person });
const memberLink = (value) => mapFields(value, { member: person });
const comment = (value) => {
    const source = record(mapFields(value, { author: person, createdBy: person, actor: person }));
    if (!source)
        return value;
    const { avatarUrl: _avatar, initials: _initials, ...result } = source;
    // content/entries содержат пользовательский rich text и immutable audit.
    // Их поля и прошлые значения сохраняются, даже если они похожи на UI metadata.
    return result;
};
const checklist = (value) => mapFields(value, {
    createdBy: person,
    items: list((item) => mapFields(item, { createdBy: person, completedBy: person, assignee: person })),
});
const task = (value) => mapFields(value, {
    assignee: person, createdBy: person, participants: persons, participantGroups: persons,
    availableMembers: persons, availableMemberGroups: persons, mentionableMembers: persons,
    controls: list(control), comments: list(comment), checklists: list(checklist),
    attachments: list(attachment), deletedAttachments: list(attachment),
    subscriptions: list(memberLink), substitution: (item) => mapFields(item, { member: person }),
});
const taskMutationTools = new Set([
    "create_task", "apply_task_patch", "update_task_title", "update_task_description",
    "update_task_status", "update_task_due_date", "update_task_urgency", "update_task_assignee",
    "set_task_participants", "update_task_custom_field", "move_task_to_project", "create_subtask",
    "convert_checklist_item_to_subtask", "create_checklist", "update_checklist", "delete_checklist",
    "add_checklist_items", "complete_checklist_item", "create_task_control", "update_task_control",
    "clear_task_control", "delete_attachment", "upload_attachment", "upload_inline_image",
]);
const taskReadTools = new Set([
    "get_task", "get_tasks", "get_task_sections", "get_task_review_context", "plan_task_update",
    "get_task_activity", "list_my_tasks", "list_project_tasks", "search_tasks",
]);
const contactTools = new Set([
    "get_contact", "create_contact", "update_contact", "list_contacts",
    "create_contact_comment", "update_contact_comment",
]);
const registryTools = new Set([
    "get_registry", "create_registry", "update_registry_definition", "upsert_registry_rows",
    "archive_registry_rows", "set_registry_workspaces", "set_registry_tasks", "list_registries",
]);
const meetingTools = new Set([
    "get_meeting", "create_meeting", "set_meeting_access", "record_meeting_result",
    "plan_meeting_context_updates", "confirm_meeting_context_updates", "record_meeting_context_update_outcome",
]);
const peopleTools = new Set([
    "get_project_meta", "get_task_create_meta", "resolve_user", "resolve_company_member", "resolve_status",
]);
const projectTaskPayload = (payload) => mapFields(payload, {
    task, tasks: list((item) => {
        const entry = record(item);
        return entry && own(entry, "task") ? mapFields(entry, { task }) : task(item);
    }),
    controls: list(control), checklists: list(checklist), comments: list(comment),
    sections: (value) => {
        const sections = record(value);
        if (!sections)
            return value;
        return Object.fromEntries(Object.entries(sections).map(([name, section]) => [name, task(section)]));
    },
});
const addDeferred = (payload, fields, readBack) => {
    if (own(payload, "deferredData"))
        return payload;
    const present = fields.filter((field) => own(payload, field));
    if (!present.length)
        return payload;
    const result = { ...payload };
    for (const field of present)
        delete result[field];
    const deferred = {
        ...result,
        deferredData: {
            fields: present,
            ...readBack,
            instruction: "Поля отложены. При необходимости выполните указанное точное read-only чтение; повторная mutation для получения подробностей запрещена.",
        },
    };
    // Пустой/короткий справочник дешевле передать сразу, чем объявлять отложенное
    // чтение. Это также не заставляет агента делать второй call ради пары записей.
    // Сравниваем только изменённую часть: повторная сериализация всех registry
    // rows ради маленького history/sidebar не должна удваивать память ответа.
    const omitted = Object.fromEntries(present.map((field) => [field, payload[field]]));
    return JSON.stringify({ deferredData: deferred.deferredData }).length < JSON.stringify(omitted).length ? deferred : payload;
};
const taskLocator = (payload, argumentsObject) => {
    const document = record(payload.document);
    const metadata = record(document?.metadata);
    const currentTask = record(payload.task);
    const companySlug = metadata?.company ?? argumentsObject.companySlug;
    const projectSlug = metadata?.project ?? argumentsObject.projectSlug;
    const taskNumber = currentTask?.number ?? metadata?.taskNumber ?? argumentsObject.taskNumber;
    return typeof companySlug === "string" && typeof projectSlug === "string"
        && (typeof taskNumber === "number" || typeof taskNumber === "string")
        && Number.isSafeInteger(Number(taskNumber)) && Number(taskNumber) > 0
        ? { companySlug, projectSlug, taskNumber: Number(taskNumber) } : null;
};
const projectTaskMutation = (payload, argumentsObject) => {
    let result = projectTaskPayload(payload);
    result = mapFields(result, { subtask: task, checklist, comment, attachment, deletedAttachment: attachment });
    const currentTask = record(result.task);
    const document = record(result.document);
    const locator = taskLocator(payload, argumentsObject);
    if (!currentTask || !document || !locator)
        return result;
    // document.text – производное представление той же задачи. Сохраняем его
    // identity/URL/company/project metadata, чтобы перенос задачи не оставил агенту
    // прежний locator. Остальные domain поля, явные effects и replayed не трогаем.
    const { text: _text, ...documentIdentity } = document;
    result = { ...result, document: documentIdentity };
    const deferredFields = ["availableMembers", "availableMemberGroups", "mentionableMembers", "templates"];
    const fields = deferredFields.filter((field) => own(currentTask, field));
    if (fields.length) {
        const sections = [
            ...(fields.some((field) => field !== "templates") ? ["people"] : []),
            ...(fields.includes("templates") ? ["templates"] : []),
        ];
        result.task = addDeferred(currentTask, fields, {
            tool: "get_task_sections", arguments: { ...locator, sections },
        });
    }
    // imageNode является полным каноническим результатом вставки. Примеры имеют
    // право исчезнуть только при наличии этого узла; legacy replay без него цел.
    if (record(result.imageNode)) {
        delete result.bodyJsonExample;
        delete result.descriptionJsonExample;
    }
    return result;
};
const projectCatalogSkill = (value) => {
    const skill = record(value);
    if (!skill || typeof skill.id !== "string")
        return value;
    const { instructionsMarkdown: _instructions, connectionDefinition: _definition, runtimeRelease, remoteMcp, connection, ...summary } = skill;
    // Все остальные assignment/routing/readiness/requirements поля сохраняются.
    // Здесь нет truncation description: это смысловой материал для выбора навыка.
    const runtime = record(runtimeRelease);
    const remote = record(remoteMcp);
    const configuredConnection = record(connection);
    return {
        ...summary,
        ...(runtime ? { runtimeRelease: Object.fromEntries(Object.entries(runtime).filter(([key]) => (key !== "manifest" && key !== "publication"))) } : { runtimeRelease }),
        ...(remote ? { remoteMcp: Object.fromEntries(Object.entries(remote).filter(([key]) => key !== "config")) } : { remoteMcp }),
        ...(configuredConnection ? { connection: Object.fromEntries(Object.entries(configuredConnection).filter(([key]) => (key !== "config" && key !== "secretBindings"))) } : { connection }),
    };
};
const RUN_SNAPSHOT_FIELDS = [
    "agentInstructionsSnapshotJson", "userProfileSnapshotJson", "runtimePolicySnapshotJson",
    "runtimeAttestationJson", "clientMetadataJson",
];
const projectWorkspaceOverview = (payload) => {
    // Это внутрисообщенческие ссылки, а не cache keys: каждый полный immutable
    // snapshot остаётся в том же ответе. Не склеиваем разные authority fields.
    if (!Array.isArray(payload.runs) || own(payload, "runSnapshots")
        || payload.runs.some((run) => { const item = record(run); return item && own(item, "snapshotRefs"); }))
        return payload;
    const candidates = new Map();
    for (const run of payload.runs) {
        const entry = record(run);
        if (!entry)
            continue;
        for (const field of RUN_SNAPSHOT_FIELDS) {
            if (!record(entry[field]))
                continue;
            const encoded = JSON.stringify(entry[field]);
            // Маленькие/null snapshots дешевле оставить на месте. Сравниваем exact
            // serialization: разный порядок ключей лишь упустит экономию, не смысл.
            if (encoded.length < 256)
                continue;
            const key = field + ":" + encoded;
            const previous = candidates.get(key);
            candidates.set(key, { field, value: entry[field], count: (previous?.count ?? 0) + 1 });
        }
    }
    const shared = new Map([...candidates].filter(([, item]) => item.count > 1)
        .map(([key, item], index) => [key, { id: `snapshot-${index + 1}`, field: item.field, value: item.value }]));
    if (!shared.size)
        return payload;
    const projected = {
        ...payload,
        runs: payload.runs.map((run) => {
            const entry = record(run);
            if (!entry)
                return run;
            const result = { ...entry };
            const refs = {};
            for (const field of RUN_SNAPSHOT_FIELDS) {
                const snapshot = shared.get(field + ":" + JSON.stringify(entry[field]));
                if (snapshot) {
                    delete result[field];
                    refs[field] = snapshot.id;
                }
            }
            return Object.keys(refs).length ? { ...result, snapshotRefs: refs } : run;
        }),
        runSnapshots: {
            entries: [...shared.values()],
            instruction: "Каждое поле run.snapshotRefs ссылается на полный снимок в этом ответе. У каждого Run свои закреплённые правила; текущие инструкции не заменяют исторический снимок.",
        },
    };
    // Для двух маленьких снимков ссылки и объяснение могут быть дороже дубля.
    // Проверяем только Run-часть, не сериализуя заново file manifests/overview.
    return JSON.stringify({ runs: projected.runs, runSnapshots: projected.runSnapshots }).length
        < JSON.stringify({ runs: payload.runs }).length ? projected : payload;
};
/** Полный обход только известных domain positions; errors/Apps обрабатывает caller. */
export const projectMcpAgentPayload = (toolName, value, rawArguments = {}) => {
    const payload = record(value);
    const args = record(rawArguments) ?? {};
    if (!payload || (MCP_RESPONSE_DETAIL_TOOLS.has(toolName) && args.responseDetail === "full"))
        return value;
    if (toolName === "get_agent_workspace" || toolName === "get_agent_workspace_by_scope")
        return projectWorkspaceOverview(payload);
    if (taskMutationTools.has(toolName))
        return projectTaskMutation(payload, args);
    if (toolName === "batch_update_tasks") {
        return mapFields(payload, { results: list((item) => {
                const result = record(item);
                // Failed elements содержат errors/conflicts, а не обычный task payload.
                const nested = record(result?.payload);
                if (!result || result.ok !== true || !nested)
                    return item;
                const operation = Array.isArray(args.operations) && typeof result.index === "number"
                    ? record(args.operations[result.index]) ?? {} : {};
                return { ...result, payload: payload.dryRun === false
                        ? projectTaskMutation(nested, operation) : projectTaskPayload(nested) };
            }) });
    }
    if (taskReadTools.has(toolName))
        return projectTaskPayload(payload);
    if (toolName === "create_comment" || toolName === "update_comment")
        return mapFields(payload, { comment });
    if (peopleTools.has(toolName)) {
        let result = mapFields(payload, {
            members: persons, groups: persons, memberGroups: persons,
            availableMembers: persons, availableMemberGroups: persons, mentionableMembers: persons,
        });
        // Удаляем только доказанное равенство списков. Различие ACL/candidates остаётся
        // видимым, даже если два списка имеют почти одинаковые display names.
        const aliases = {};
        for (const [alias, canonical] of [["availableMembers", "members"], ["availableMemberGroups", "memberGroups"]]) {
            if (Array.isArray(result[alias]) && Array.isArray(result[canonical]) && equal(result[alias], result[canonical])) {
                delete result[alias];
                aliases[alias] = canonical;
            }
        }
        if (Object.keys(aliases).length)
            result = { ...result, collectionAliases: aliases };
        return result;
    }
    if (contactTools.has(toolName)) {
        const projectContact = (item) => mapFields(item, {
            createdBy: person, updatedBy: person, memberLinks: list(memberLink), comments: list(comment),
            activity: list(comment), events: list(comment),
        });
        let result = mapFields(payload, { contact: projectContact, contacts: list(projectContact), comment });
        const contactRecord = record(result.contact);
        const company = record(result.company);
        if (contactRecord && typeof contactRecord.id === "string" && typeof company?.slug === "string") {
            result = addDeferred(result, ["options"], { tool: "get_contact", arguments: {
                    companySlug: company.slug, contactId: contactRecord.id, responseDetail: "full",
                } });
        }
        return result;
    }
    if (registryTools.has(toolName)) {
        let result = mapFields(payload, { mentionableMembers: persons, comments: list(comment) });
        const registry = record(result.registry);
        const company = record(result.company);
        const project = record(result.project);
        if (registry && typeof registry.slug === "string" && typeof company?.slug === "string") {
            const readArgs = {
                ...args, companySlug: company.slug,
                ...(typeof project?.slug === "string" ? { projectSlug: project.slug } : {}),
                registrySlug: registry.slug, responseDetail: "full",
            };
            // Не переносим mutation fields в read hint. Контекст выбранной страницы
            // сохраняет только реально поддерживаемые read filters/limits.
            const readFields = new Set(["companySlug", "projectSlug", "registrySlug", "query", "filters", "sortKey", "sortDirection", "offset", "limit", "includeArchivedRows", "historyLimit", "responseDetail"]);
            result = addDeferred(result, ["history", "comments", "commentsPagination", "mentionableMembers"], {
                tool: "get_registry", arguments: Object.fromEntries(Object.entries(readArgs).filter(([key]) => readFields.has(key))),
            });
        }
        return result;
    }
    if (meetingTools.has(toolName))
        return mapFields(payload, {
            meeting: (item) => mapFields(item, { createdBy: person }),
            participants: list((item) => mapFields(item, { member: person })),
            additionalAccess: list(memberLink),
        });
    if (toolName === "list_agent_skills" && Array.isArray(payload.skills)) {
        return { ...payload, skills: payload.skills.map(projectCatalogSkill), skillDetails: {
                tool: "get_agent_skill", instruction: "Перед использованием загрузите точный skillId в той же компании/проекте: полный текст инструкций, схему подключения и декларацию исполнения.",
            } };
    }
    if (toolName === "get_knowledge_base_page") {
        const page = record(payload.page);
        const company = record(payload.company);
        let result = mapFields(payload, { page: (item) => mapFields(item, { createdBy: person, updatedBy: person }) });
        if (typeof page?.slug === "string" && typeof company?.slug === "string")
            result = addDeferred(result, ["pages"], {
                tool: "get_knowledge_base_page", arguments: { companySlug: company.slug, pageSlug: page.slug, responseDetail: "full" },
            });
        return result;
    }
    if (toolName === "list_recent_activity") {
        let result = mapFields(payload, { events: list((item) => mapFields(item, { actor: person, author: person })) });
        if (typeof args.companySlug === "string")
            result = addDeferred(result, ["feeds", "filterOptions"], {
                tool: "list_recent_activity", arguments: {
                    ...Object.fromEntries(Object.entries(args).filter(([key]) => ["companySlug", "feedId", "cursor", "limit"].includes(key))), responseDetail: "full",
                },
            });
        return result;
    }
    if (toolName === "list_company_activity")
        return mapFields(payload, { items: list((item) => mapFields(item, { actor: person })) });
    // Неизвестный tool/shape сохраняется целиком. Generic provider responses,
    // instructions, snapshots, approval boundaries и arbitrary JSON не обрезаются.
    return value;
};
