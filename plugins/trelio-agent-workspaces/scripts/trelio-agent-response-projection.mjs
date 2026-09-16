// Generated portable Trelio response contract. Do not edit by hand.
export const MCP_RESPONSE_PROJECTION_VERSION = 1;
export const MCP_RESPONSE_DETAIL_TOOLS = new Set([
    "get_contact", "get_registry", "get_knowledge_base_page", "get_project_meta",
    "get_task_create_meta", "get_regular_work", "list_recent_activity", "list_agent_skills",
    "get_agent_skill", "get_agent_workspace", "get_agent_workspace_by_scope",
    "list_agent_secrets",
]);
export const MCP_RESPONSE_FIELD_TOOLS = {
    get_contact: ["options"],
    get_registry: ["history", "comments", "commentsPagination", "mentionableMembers"],
    get_knowledge_base_page: ["pages"],
    get_regular_work: ["history", "preparation", "options", "mentionableMembers"],
    list_recent_activity: ["feeds", "filterOptions"],
};
export const MCP_AGENT_SKILL_SECTION_NAMES = [
    "instructions", "connection", "execution", "publication",
];
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
const stringArray = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
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
const regularWorkTools = new Set([
    "get_regular_work", "create_or_update_regular_work", "complete_regular_check",
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
const addDeferred = (payload, fields, readBack, rawArguments = {}) => {
    if (own(payload, "deferredData"))
        return payload;
    const present = fields.filter((field) => own(payload, field));
    const requested = new Set(stringArray(rawArguments.responseFields));
    const deferredFields = present.filter((field) => !requested.has(field));
    if (!deferredFields.length)
        return payload;
    const result = { ...payload };
    for (const field of deferredFields)
        delete result[field];
    const deferred = {
        ...result,
        deferredData: {
            fields: deferredFields,
            tool: readBack.tool,
            arguments: {
                ...readBack.arguments,
                responseFields: deferredFields,
            },
            instruction: "Поля отложены. Запросите через responseFields только нужный subset; повторная mutation для получения подробностей запрещена.",
        },
    };
    // Пустой/короткий справочник дешевле передать сразу, чем объявлять отложенное
    // чтение. Это также не заставляет агента делать второй call ради пары записей.
    // Сравниваем только изменённую часть: повторная сериализация всех registry
    // rows ради маленького history/sidebar не должна удваивать память ответа.
    const omitted = Object.fromEntries(deferredFields.map((field) => [field, payload[field]]));
    // Explicit selection is a semantic projection, not merely a size hint:
    // never reintroduce a small unrequested field because it serialized cheaply.
    // The default path may still inline a tiny collection to avoid a net increase.
    return requested.size > 0
        || JSON.stringify({ deferredData: deferred.deferredData }).length < JSON.stringify(omitted).length
        ? deferred : payload;
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
const TASK_SECTION_FIELDS = {
    rich_description: ["descriptionJson"],
    comments: ["commentsIncluded", "comments", "commentsUnread", "commentsPagination", "subscriptions", "viewerSubscription"],
    checklists: ["checklists"],
    attachments: ["attachments", "deletedAttachments"],
    controls: ["controls"],
    relationships: ["parentTask", "subtasks"],
    workflow: ["statuses", "absenceConflicts"],
    people: ["availableMembers", "availableMemberGroups", "mentionableMembers"],
    templates: ["templates"],
    custom_fields: ["customFields"],
};
const TASK_SECTION_NAMES = Object.keys(TASK_SECTION_FIELDS);
const TASK_DEFERRED_FIELDS = new Set([
    ...TASK_SECTION_NAMES.flatMap((name) => [...TASK_SECTION_FIELDS[name]]),
    // This is the derived plain copy of `descriptionJson`. A bounded prefix in
    // summary keeps the receipt useful without returning the whole document.
    "descriptionPlainText",
]);
const arrayLength = (value) => Array.isArray(value) ? value.length : 0;
const nestedArrayLength = (value, field) => arrayLength(record(value)?.[field]);
const taskSectionItemCount = (currentTask, section) => {
    switch (section) {
        case "rich_description": return String(currentTask.descriptionPlainText ?? "").trim() ? 1 : 0;
        case "comments": {
            if (currentTask.commentsIncluded !== true)
                return null;
            const total = record(currentTask.commentsPagination)?.total;
            return typeof total === "number" && Number.isSafeInteger(total) && total >= 0
                ? total : arrayLength(currentTask.comments);
        }
        case "checklists": return arrayLength(currentTask.checklists);
        case "attachments": return arrayLength(currentTask.attachments) + arrayLength(currentTask.deletedAttachments);
        case "controls": return arrayLength(currentTask.controls);
        case "relationships": return (currentTask.parentTask ? 1 : 0) + arrayLength(currentTask.subtasks);
        case "workflow": return arrayLength(currentTask.statuses) + arrayLength(currentTask.absenceConflicts);
        case "people": return arrayLength(currentTask.availableMembers) + arrayLength(currentTask.availableMemberGroups);
        case "templates": return Array.isArray(currentTask.templates)
            ? currentTask.templates.length
            : nestedArrayLength(currentTask.templates, "description") + nestedArrayLength(currentTask.templates, "checklist");
        case "custom_fields": return Array.isArray(currentTask.customFields)
            ? currentTask.customFields.length : nestedArrayLength(currentTask.customFields, "fields");
    }
};
const projectTaskMutationCore = (currentTask, locator) => {
    if (own(currentTask, "deferredSections"))
        return currentTask;
    const core = Object.fromEntries(Object.entries(currentTask).filter(([field]) => !TASK_DEFERRED_FIELDS.has(field)));
    const description = typeof currentTask.descriptionPlainText === "string"
        ? Array.from(currentTask.descriptionPlainText) : null;
    return {
        ...core,
        ...(!own(core, "summary") && description ? { summary: {
                descriptionPreview: description.slice(0, 320).join(""),
                descriptionTruncated: description.length > 320,
                fullDescriptionSection: "rich_description",
            } } : {}),
        deferredSections: {
            tool: "get_task_sections",
            arguments: { ...locator, sections: TASK_SECTION_NAMES },
            available: TASK_SECTION_NAMES.map((name) => ({ name, itemCount: taskSectionItemCount(currentTask, name) })),
            instruction: "После mutation загружайте одним get_task_sections только нужные sections; повторять mutation или полное чтение задачи для этого запрещено.",
        },
    };
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
    result.task = projectTaskMutationCore(currentTask, locator);
    // imageNode является полным каноническим результатом вставки. Примеры имеют
    // право исчезнуть только при наличии этого узла; legacy replay без него цел.
    if (record(result.imageNode)) {
        delete result.bodyJsonExample;
        delete result.descriptionJsonExample;
    }
    return result;
};
const projectRegularWorkDetail = (value) => mapFields(value, {
    mentionableMembers: persons,
    options: (item) => mapFields(item, {
        availableMembers: persons,
        availableMemberGroups: persons,
        members: persons,
        groups: persons,
    }),
});
const deferRegularWorkDetail = (value, args) => {
    const payload = record(projectRegularWorkDetail(value));
    if (!payload)
        return value;
    const company = record(payload.company);
    const project = record(payload.project);
    const set = record(payload.set);
    const companySlug = company?.slug ?? args.companySlug;
    const projectSlug = project?.slug ?? args.projectSlug;
    const setId = set?.id ?? args.setId;
    if (typeof companySlug !== "string" || typeof projectSlug !== "string" || typeof setId !== "string") {
        return payload;
    }
    return addDeferred(payload, ["history", "preparation", "options", "mentionableMembers"], {
        tool: "get_regular_work",
        arguments: { companySlug, projectSlug, setId },
    }, args);
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
const ACTIVE_RUN_STATUSES = new Set(["running", "waiting_for_human", "review"]);
const WORKSPACE_RECENT_TERMINAL_RUN_LIMIT = 5;
const WORKSPACE_RECENT_CHECKPOINT_LIMIT = 10;
const projectWorkspaceOverview = (payload) => {
    if (!Array.isArray(payload.runs) || own(payload, "overviewSummary"))
        return payload;
    // Overview is a navigation/readiness read, not an authority-materialization
    // endpoint. Keep every active Run plus a bounded recent terminal history;
    // pinned rules/profile/runtime snapshots remain available through an exact
    // explicit full read and through the bridge that actually executes the Run.
    const activeRuns = payload.runs.filter((run) => {
        const entry = record(run);
        return entry ? ACTIVE_RUN_STATUSES.has(String(entry.status ?? "")) : false;
    });
    const terminalRuns = payload.runs.filter((run) => {
        const entry = record(run);
        return entry ? !ACTIVE_RUN_STATUSES.has(String(entry.status ?? "")) : true;
    }).slice(0, WORKSPACE_RECENT_TERMINAL_RUN_LIMIT);
    const selectedRuns = [...activeRuns, ...terminalRuns];
    const selectedRunIds = new Set(selectedRuns.flatMap((run) => {
        const entry = record(run);
        return typeof entry?.id === "string" ? [entry.id] : [];
    }));
    const checkpoints = Array.isArray(payload.checkpoints) ? payload.checkpoints : [];
    const selectedCheckpoints = checkpoints.filter((checkpoint) => {
        const entry = record(checkpoint);
        return typeof entry?.runId !== "string" || selectedRunIds.has(entry.runId);
    }).slice(0, WORKSPACE_RECENT_CHECKPOINT_LIMIT);
    const compactRun = (run) => {
        const entry = record(run);
        if (!entry)
            return run;
        const result = { ...entry };
        for (const field of RUN_SNAPSHOT_FIELDS)
            delete result[field];
        delete result.handoffJson;
        return result;
    };
    const workspace = record(payload.workspace);
    return {
        ...payload,
        runs: selectedRuns.map(compactRun),
        checkpoints: selectedCheckpoints,
        overviewSummary: {
            runsTotal: payload.runs.length,
            runsReturned: selectedRuns.length,
            checkpointsTotal: checkpoints.length,
            checkpointsReturned: selectedCheckpoints.length,
            activeRunsAreAlwaysIncluded: true,
        },
        deferredData: {
            fields: ["completeRunHistory", "completeCheckpointHistory", "pinnedRunAuthoritySnapshots"],
            tool: "get_agent_workspace",
            arguments: {
                ...(typeof workspace?.id === "string" ? { workspaceId: workspace.id } : {}),
                responseDetail: "full",
            },
            instruction: "Use responseDetail=full only for an explicit historical or pinned-authority audit. Ordinary Workspace navigation and Run recovery use this compact overview or the prepared bridge action.",
        },
    };
};
const projectAgentSecretInventory = (payload, args) => {
    if (!Array.isArray(payload.secrets) || own(payload, "deferredData"))
        return payload;
    return {
        ...payload,
        secrets: payload.secrets.map((value) => {
            const secret = record(value);
            if (!secret)
                return value;
            const { publicDescription: _publicDescription, fields: _fields, publicPath: _publicPath, createdByMemberId: _createdBy, createdAt: _createdAt, updatedAt: _updatedAt, rotationReminderDays: _rotationReminderDays, notifyOnSensitiveEvents: _notifyOnSensitiveEvents, ...summary } = secret;
            return summary;
        }),
        deferredData: {
            fields: ["publicDescription", "fields", "auditMetadata", "rotationPolicy"],
            tool: "list_agent_secrets",
            arguments: {
                scopeType: payload.scope ? record(payload.scope)?.type ?? args.scopeType : args.scopeType,
                scopeId: args.scopeId,
                includeParents: args.includeParents ?? true,
                responseDetail: "full",
            },
            instruction: "Choose exact secretIds from this inventory and request responseDetail=full only for those secrets. Values are never returned.",
        },
    };
};
const projectCancelledWorkspaceRun = (payload) => {
    const run = record(payload.run);
    if (!run)
        return payload;
    return {
        schemaVersion: 1,
        action: "cancel_agent_workspace_run",
        run: {
            id: run.id ?? null,
            workspaceId: run.workspaceId ?? null,
            status: run.status ?? null,
            fencingToken: run.fencingToken ?? null,
            cancelledAt: run.cancelledAt ?? null,
            updatedAt: run.updatedAt ?? null,
        },
    };
};
const projectAgentSkillDetail = (payload, args) => {
    const skill = record(payload.skill);
    if (!skill || typeof skill.id !== "string" || own(payload, "deferredData"))
        return payload;
    const runtimeRelease = record(skill.runtimeRelease);
    const executionKind = runtimeRelease
        ? "signed_runtime"
        : record(skill.remoteMcp) ? "remote_mcp" : "instructions_only";
    const releaseIdentity = typeof skill.currentReleaseId === "string"
        ? skill.currentReleaseId
        : typeof runtimeRelease?.releaseId === "string"
            ? runtimeRelease.releaseId
            : typeof skill.version === "string" ? skill.version : "unversioned";
    // Project scope is part of the structural key: the same catalog skill and
    // release may resolve to different effective instructions per assignment.
    // Intent remains a caller-side reuse condition and is never inferred here.
    const instructionKey = `agent-skill:${String(payload.companySlug ?? args.companySlug ?? "unknown")}:${String(payload.projectSlug ?? args.projectSlug ?? "company")}:${skill.id}:${releaseIdentity}`;
    const requested = new Set(stringArray(args.sections).filter((section) => (MCP_AGENT_SKILL_SECTION_NAMES.includes(section))));
    const available = [
        ...(own(skill, "instructionsMarkdown") ? ["instructions"] : []),
        ...(own(skill, "connectionDefinition") || own(skill, "connection") || own(payload, "localIdentity")
            ? ["connection"] : []),
        ...(own(skill, "runtimeRequirements") || own(skill, "runtimeRelease") || own(skill, "remoteMcp")
            || own(payload, "runtimeExecution") || own(payload, "remoteMcpExecution") ? ["execution"] : []),
        ...(runtimeRelease && own(runtimeRelease, "publication")
            && runtimeRelease.publication !== null && runtimeRelease.publication !== undefined
            ? ["publication"] : []),
    ];
    const reuseInstructions = requested.has("instructions")
        && args.knownInstructionKey === instructionKey;
    const { instructionsMarkdown, connectionDefinition, connection, runtimeRequirements, runtimeRelease: _runtimeRelease, remoteMcp, ...skillSummary } = skill;
    let projectedSkill = {
        ...skillSummary,
        instructionKey,
        executionSummary: {
            kind: executionKind,
            releaseId: releaseIdentity,
            trustLevel: runtimeRelease?.trustLevel ?? null,
            minimumHostVersion: runtimeRelease?.minimumHostVersion
                ?? record(remoteMcp)?.minimumHostVersion ?? skill.minPluginVersion ?? null,
            contentProtection: runtimeRelease?.contentProtection
                ?? record(remoteMcp)?.contentProtection ?? null,
        },
    };
    if (requested.has("instructions") && !reuseInstructions) {
        projectedSkill = { ...projectedSkill, instructionsMarkdown };
    }
    if (requested.has("connection")) {
        projectedSkill = { ...projectedSkill, connectionDefinition, connection };
    }
    if (requested.has("execution")) {
        let projectedRuntimeRelease = _runtimeRelease;
        if (runtimeRelease && !requested.has("publication")) {
            const { publication: _publication, ...withoutPublication } = runtimeRelease;
            projectedRuntimeRelease = withoutPublication;
        }
        projectedSkill = {
            ...projectedSkill,
            runtimeRequirements,
            runtimeRelease: projectedRuntimeRelease,
            remoteMcp,
        };
    }
    else if (requested.has("publication") && runtimeRelease) {
        projectedSkill = {
            ...projectedSkill,
            runtimeRelease: {
                releaseId: runtimeRelease.releaseId ?? releaseIdentity,
                publication: runtimeRelease.publication,
            },
        };
    }
    let runtimeExecution = payload.runtimeExecution;
    if (requested.has("execution")) {
        const execution = record(runtimeExecution);
        if (execution) {
            const trust = record(execution.trust);
            const { command: _legacyCommand, ...modernExecution } = execution;
            runtimeExecution = {
                // Remove the legacy duplicate only when the typed route is actually
                // present. Older hydrated server payloads may still be command-only.
                ...(own(execution, "localAction") ? modernExecution : execution),
                ...(trust ? { trust: {
                        ...Object.fromEntries(Object.entries(trust).filter(([key]) => key !== "publication")),
                        ...(own(trust, "publication") && trust.publication !== null
                            && trust.publication !== undefined ? { publicationSection: "publication" } : {}),
                    } } : {}),
            };
        }
    }
    const includedSections = available.filter((section) => (requested.has(section) && !(section === "instructions" && reuseInstructions)));
    const deferredSections = available.filter((section) => (!requested.has(section) && !(section === "instructions" && reuseInstructions)));
    const projected = {
        ...Object.fromEntries(Object.entries(payload).filter(([key]) => (!["skill", "localIdentity", "runtimeExecution", "remoteMcpExecution"].includes(key)))),
        schemaVersion: 2,
        skill: projectedSkill,
        responseProjection: {
            includedSections,
            reusedSections: reuseInstructions ? ["instructions"] : [],
            revision: {
                skillId: skill.id,
                version: skill.version ?? null,
                releaseId: releaseIdentity,
            },
        },
        ...(requested.has("connection") ? { localIdentity: payload.localIdentity } : {}),
        ...(requested.has("execution") ? {
            runtimeExecution,
            remoteMcpExecution: payload.remoteMcpExecution,
        } : {}),
    };
    if (!deferredSections.length)
        return projected;
    return {
        ...projected,
        deferredData: {
            sections: deferredSections,
            tool: "get_agent_skill",
            arguments: {
                companySlug: payload.companySlug ?? args.companySlug,
                ...(payload.projectSlug ?? args.projectSlug
                    ? { projectSlug: payload.projectSlug ?? args.projectSlug } : {}),
                skillId: skill.id,
                sections: deferredSections,
            },
            instruction: "Загрузите только нужные sections. Перед первым внешним действием нужны instructions и execution; connection – только для настройки, publication – для проверки происхождения релиза.",
        },
    };
};
/** Полный обход только известных domain positions; errors/Apps обрабатывает caller. */
export const projectMcpAgentPayload = (toolName, value, rawArguments = {}) => {
    const payload = record(value);
    const args = record(rawArguments) ?? {};
    if (!payload || (MCP_RESPONSE_DETAIL_TOOLS.has(toolName) && args.responseDetail === "full"))
        return value;
    if (toolName === "get_agent_skill")
        return projectAgentSkillDetail(payload, args);
    if (toolName === "get_agent_workspace" || toolName === "get_agent_workspace_by_scope")
        return projectWorkspaceOverview(payload);
    if (toolName === "list_agent_secrets")
        return projectAgentSecretInventory(payload, args);
    if (toolName === "cancel_agent_workspace_run")
        return projectCancelledWorkspaceRun(payload);
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
                    companySlug: company.slug, contactId: contactRecord.id,
                } }, args);
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
                registrySlug: registry.slug,
            };
            // Не переносим mutation fields в read hint. Контекст выбранной страницы
            // сохраняет только реально поддерживаемые read filters/limits.
            const readFields = new Set(["companySlug", "projectSlug", "registrySlug", "query", "filters", "sortKey", "sortDirection", "offset", "limit", "includeArchivedRows", "historyLimit", "responseDetail"]);
            result = addDeferred(result, ["history", "comments", "commentsPagination", "mentionableMembers"], {
                tool: "get_registry", arguments: Object.fromEntries(Object.entries(readArgs).filter(([key]) => readFields.has(key))),
            }, args);
        }
        return result;
    }
    if (meetingTools.has(toolName))
        return mapFields(payload, {
            meeting: (item) => mapFields(item, { createdBy: person }),
            participants: list((item) => mapFields(item, { member: person })),
            additionalAccess: list(memberLink),
        });
    if (regularWorkTools.has(toolName)) {
        if (toolName === "get_regular_work")
            return deferRegularWorkDetail(payload, args);
        const detail = record(payload.regularWork);
        return detail ? { ...payload, regularWork: deferRegularWorkDetail(detail, args) } : payload;
    }
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
                tool: "get_knowledge_base_page", arguments: { companySlug: company.slug, pageSlug: page.slug },
            }, args);
        return result;
    }
    if (toolName === "list_recent_activity") {
        let result = mapFields(payload, { events: list((item) => mapFields(item, { actor: person, author: person })) });
        if (typeof args.companySlug === "string")
            result = addDeferred(result, ["feeds", "filterOptions"], {
                tool: "list_recent_activity", arguments: {
                    ...Object.fromEntries(Object.entries(args).filter(([key]) => ["companySlug", "feedId", "cursor", "limit"].includes(key))),
                },
            }, args);
        return result;
    }
    if (toolName === "list_company_activity")
        return mapFields(payload, { items: list((item) => mapFields(item, { actor: person })) });
    // Неизвестный tool/shape сохраняется целиком. Generic provider responses,
    // instructions, snapshots, approval boundaries и arbitrary JSON не обрезаются.
    return value;
};
