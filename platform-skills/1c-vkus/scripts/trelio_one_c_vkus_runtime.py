#!/usr/bin/env python3
"""Shared read-only runtime core for Trelio's ``1c-edo`` and ``1c`` skills.

The runtime deliberately separates three trust domains:

* Trelio supplies normalized non-secret company configuration through the
  signed package host;
* the shared ``X-OData`` value arrives only through a one-use Agent Secret
  checkout environment variable;
* personal 1C credentials are entered locally and stay in a private namespace
  outside chat, MCP, Agent Workspaces, process arguments and Git.

Only a fixed set of GET/HEAD requests can be built below. There is no generic
URL, entity, OData expression or HTTP-method escape hatch.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import datetime as dt
import email.utils
import errno
import getpass
import hashlib
import hmac
import ipaddress
import json
import os
import re
import shutil
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Iterable, Mapping


VKUS_SKILL_ID = "company-33638f79-4d63-47f8-ab40-55ed70331592-1c-vkus"
SUPPORTED_SKILL_IDS = frozenset({VKUS_SKILL_ID})
# The Vkus-private broad surface intentionally uses the universal EDO provider
# namespace. The backend resolves the existing 1c-edo connection id, so local
# Basic Auth credentials remain usable without copying or migration.
CREDENTIAL_PROVIDER_NAMESPACE = "1c-edo"
RUNTIME_VERSION = "1.0.13"
X_ODATA_ENV = "TRELIO_1C_EDO_X_ODATA"
CONNECTION_CONFIG_ENV = "TRELIO_SKILL_CONNECTION_CONFIG_JSON"
ACCESS_STATES = ("unknown", "no_access", "connected", "needs_reconnect")
DOCUMENT_ENTITIES = {
    "incoming": "Document_ЭлектронныйДокументВходящийЭДО",
    "outgoing": "Document_ЭлектронныйДокументИсходящийЭДО",
}
CONTRACT_ENTITY = "Catalog_ДоговорыКонтрагентов"
BUSINESS_ENTITY_SPECS = {
    "Catalog_ОбъектыСтроительства": {
        "kind": "construction_object",
        "contractRelationField": None,
        "diagnosticStage": "search.business.construction-object",
    },
    "Catalog_НаправленияДеятельности": {
        "kind": "business_direction",
        "contractRelationField": "НаправлениеДеятельности_Key",
        "diagnosticStage": "search.business.business-direction",
    },
    "Catalog_ПодразделенияОрганизаций": {
        "kind": "subdivision",
        "contractRelationField": None,
        "diagnosticStage": "search.business.subdivision",
    },
    "Catalog_СтруктураПредприятия": {
        "kind": "enterprise_structure",
        # Live metadata/results confirm that `Подразделение_Key` in
        # Catalog_ДоговорыКонтрагентов points to this catalog. It must not be
        # confused with Catalog_ПодразделенияОрганизаций: both can contain the
        # same human-readable location but have different UUID namespaces.
        "contractRelationField": "Подразделение_Key",
        "diagnosticStage": "search.business.enterprise-structure",
    },
}
BUSINESS_SELECT_FIELDS = ("Ref_Key", "Description")
CONTRACT_SELECT_FIELDS = (
    "Ref_Key",
    "Description",
    "Дата",
    "Номер",
    "Контрагент_Key",
    "Организация_Key",
    "НаправлениеДеятельности_Key",
    "Подразделение_Key",
    "Комментарий",
    "НаименованиеДляПечати",
)
CONTRACT_TERM_FIELDS = (
    "Description",
    "Комментарий",
    "НаименованиеДляПечати",
)
DOCUMENT_SELECT_FIELDS = (
    "Ref_Key",
    "Number",
    "Date",
    "ВидДокумента_Key",
    "ДатаДокумента",
    "ДатаПодписания",
    "ДоговорКонтрагента",
    "Комментарий",
    "Контрагент",
    "НомерДокумента",
    "ОбменБезПодписи",
    "Организация_Key",
    "Остановлен",
    "СуммаДокумента",
)
DOCUMENT_TERM_FIELDS = ("Комментарий", "НомерДокумента")
DOCUMENT_SIGNATURE_BASIS = "document_signing_date"
STATUS_REGISTER_ENTITY = "InformationRegister_СостоянияДокументовЭДО"
STATUS_REGISTER_SELECT_FIELDS = (
    "ЭлектронныйДокумент",
    "ЭлектронныйДокумент_Type",
    "Состояние",
)
DOCUMENT_STATUS_BASIS = "information_register_status"
DOCUMENT_STATUS_COVERAGE = "primary"
EDO_STATUS_NO_MATCH_REASON = "status_register_no_match"
EDO_STATUS_EMPTY_REASON = "status_register_empty"
CONTRACT_RELATION_DIAGNOSTIC_STAGES = {
    "НаправлениеДеятельности_Key": "search.contracts.by-business-direction",
    "Подразделение_Key": "search.contracts.by-subdivision",
}
NEW_FILE_ENTITY = "Catalog_КэшВизуализацииДокументовЭДОПрисоединенныеФайлы"
OLD_MESSAGE_ENTITY = "Document_СообщениеЭДО"
OLD_FILE_ENTITY = "Catalog_СообщениеЭДОПрисоединенныеФайлы"
FILE_METADATA = {
    "new": "КэшВизуализацииДокументовЭДОПрисоединенныеФайлы",
    "old": "СообщениеЭДОПрисоединенныеФайлы",
}
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
MAX_ODATA_RESPONSE_BYTES = 8 * 1024 * 1024
# Полная schema стандартной OData-публикации крупной конфигурации может быть
# заметно больше обычного бизнес-ответа. Для единственного fixed `$metadata`
# маршрута держим отдельный bounded cap; все sample/search/get ответы по-
# прежнему ограничены существенно меньшими 8 МиБ.
MAX_METADATA_RESPONSE_BYTES = 64 * 1024 * 1024
# The cache stores only a signed-runtime-derived verdict for each fixed
# capability, never raw metadata or arbitrary 1C field names.  It is not a TTL
# shortcut: every broad command still contacts the fixed metadata route.  A
# cached verdict becomes usable only after the server confirms its validator
# with HTTP 304; without ETag/Last-Modified the runtime downloads and verifies
# the complete metadata again.
GENERAL_SCHEMA_CACHE_VERSION = 1
GENERAL_SCHEMA_CACHE_LOCK_TIMEOUT_SECONDS = 180
MAX_GENERAL_SCHEMA_CACHE_BYTES = 256 * 1024
MAX_METADATA_ETAG_CHARS = 512
MAX_METADATA_LAST_MODIFIED_CHARS = 128
METADATA_ETAG_RE = re.compile(r'^(?:W/)?"[\x21\x23-\x7e]*"$')
METADATA_ACCEPT_ENCODING = "gzip"
MAX_ERROR_MESSAGE_CHARS = 300
MAX_SEARCH_QUERY_CHARS = 256
MAX_EDO_STATUS_CHARS = 512
MAX_BUSINESS_MATCHES_PER_ENTITY = 5
MAX_RELATED_BUSINESS_OBJECTS = 20
MAX_RELATED_CONTRACTS = 20
MAX_SEARCH_DOCUMENTS = 200
MAX_DOCUMENTS_PER_CONTRACT_DIRECTION = 50
MAX_STATUS_LOOKUP_DOCUMENTS = MAX_SEARCH_DOCUMENTS
STATUS_LOOKUP_BATCH_SIZE = 20
DIAGNOSTIC_STAGES = frozenset(
    {
        "connect.probe",
        "doctor.probe",
        "search.business.construction-object",
        "search.business.business-direction",
        "search.business.subdivision",
        "search.business.enterprise-structure",
        "search.contracts.by-business-direction",
        "search.contracts.by-subdivision",
        "search.contracts.text",
        "search.documents.incoming.by-contract",
        "search.documents.outgoing.by-contract",
        "search.documents.incoming.text",
        "search.documents.outgoing.text",
        "search.documents.incoming.recent",
        "search.documents.outgoing.recent",
        "document.incoming.get",
        "document.outgoing.get",
        "status.incoming.lookup",
        "status.outgoing.lookup",
        "files.incoming.new",
        "files.outgoing.new",
        "files.incoming.old-messages",
        "files.outgoing.old-messages",
        "files.incoming.old-files",
        "files.outgoing.old-files",
        "file.new.download",
        "file.old.download",
        "metadata.inventory.fetch",
        "metadata.inventory.sample",
        "general.schema.verify",
        "general.links.contracts",
        "general.links.edo.incoming",
        "general.links.edo.outgoing",
        *{
            f"general.reference.{kind}.{action}"
            for kind in (
                "organization",
                "business_unit",
                "counterparty",
                "partner",
                "contract",
                "item",
                "warehouse",
            )
            for action in ("search", "get")
        },
        *{
            f"general.document.{kind}.{action}"
            for kind in ("purchase", "sale", "receipt", "return", "transfer")
            for action in ("search", "get", "links")
        },
    },
)

# Development inventory is deliberately heuristic only at the *name matching*
# layer. It can discover a bounded set of likely business entities, but it
# cannot query an arbitrary entity or reveal raw records. Final production
# mappings are frozen later in a signed capability registry.
INVENTORY_REFERENCE_TERMS = {
    "organization": ("Организац",),
    "business_unit": (
        "СтруктураПредприятия",
        "ПодразделенияОрганизаций",
        "ОбъектыСтроительства",
        "НаправленияДеятельности",
    ),
    "counterparty": ("Контрагент",),
    "partner": ("Партнер", "Партнёр"),
    "contract": ("ДоговорыКонтрагентов",),
    "item": ("Номенклатур",),
    "warehouse": ("Склад",),
}
INVENTORY_DOCUMENT_TERMS = {
    "purchase": ("Приобрет", "Поступлен", "Закуп"),
    "sale": ("Реализац", "Продаж"),
    "receipt": ("Приход", "Оприход"),
    "return": ("Возврат",),
    "transfer": ("Передач", "Перемещ"),
}
INVENTORY_STOCK_TERMS = ("Остат", "Склад", "Товар", "Номенклатур")
INVENTORY_PREFERRED_ENTITIES = {
    ("reference", "organization"): ("Catalog_Организации",),
    ("reference", "business_unit"): (
        "Catalog_СтруктураПредприятия",
        "Catalog_ПодразделенияОрганизаций",
        "Catalog_ОбъектыСтроительства",
        "Catalog_НаправленияДеятельности",
    ),
    ("reference", "counterparty"): ("Catalog_Контрагенты",),
    ("reference", "partner"): ("Catalog_Партнеры", "Catalog_Партнёры"),
    ("reference", "contract"): ("Catalog_ДоговорыКонтрагентов",),
    ("reference", "item"): ("Catalog_Номенклатура",),
    ("reference", "warehouse"): ("Catalog_Склады",),
    ("document", "purchase"): (
        "Document_ПриобретениеТоваровУслуг",
        "Document_ПоступлениеТоваровУслуг",
    ),
    ("document", "sale"): ("Document_РеализацияТоваровУслуг",),
    ("document", "receipt"): (
        "Document_ПриходныйОрдерНаТовары",
        "Document_ОприходованиеИзлишковТоваров",
    ),
    ("document", "return"): (
        "Document_ВозвратТоваровПоставщику",
        "Document_ВозвратТоваровОтКлиента",
        "Document_ВозвратТоваровМеждуОрганизациями",
    ),
    ("document", "transfer"): (
        "Document_ПеремещениеТоваров",
        "Document_ПередачаТоваровМеждуОрганизациями",
    ),
}
INVENTORY_BLOCKED_TERMS = (
    "Зарплат",
    "Кадр",
    "Сотрудник",
    "Физическ",
    "Банк",
    "Безналич",
    "Денежн",
    "Платеж",
    "Платёж",
    "Касс",
    "Книг",
    "Бухгалтер",
    "Проводк",
    "НДФЛ",
    "Страхов",
    "Начислен",
    "Контактн",
    "Доверенност",
    "Сертификат",
)
MAX_INVENTORY_ENTITIES = 128
MAX_INVENTORY_ENTITIES_PER_CAPABILITY = 8
MAX_INVENTORY_SAMPLES_PER_CAPABILITY = 2
MAX_INVENTORY_PROPERTIES = 160

# The production broad 1C surface is intentionally frozen to the exact
# entities and EDM field types observed through the signed inventory runtime
# on 2026-07-26.  Only fields listed here can enter a query or normalized
# response.  Banking, payment, cash, HR/payroll, contacts, binary fields and
# accounting internals are deliberately absent even when the source entity
# publishes them.
GENERAL_INVENTORY_SCHEMA_DIGEST = (
    "sha256:24fdf38337a373147df742a235b9bc025f45616e4f0753fe06dc769bda45353b"
)
GENERAL_MAX_PAGE_SIZE = 25
GENERAL_MAX_PAGES = 3
GENERAL_MAX_LINES = 100
GENERAL_MAX_LINK_CONTRACTS = 20
GENERAL_MAX_LINK_DOCUMENTS = 25
GENERAL_MAX_LINK_EDO_DOCUMENTS = 25
GENERAL_REFERENCE_SPECS: dict[str, tuple[dict[str, Any], ...]] = {
    "organization": (
        {
            "entity": "Catalog_Организации",
            "sourceType": "organization",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Description": "Edm.String",
                "НаименованиеПолное": "Edm.String",
                "Статус": "Edm.String",
                "DeletionMark": "Edm.Boolean",
            },
            "searchFields": ("Description", "НаименованиеПолное"),
        },
    ),
    "business_unit": (
        {
            "entity": "Catalog_СтруктураПредприятия",
            "sourceType": "enterprise_structure",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Description": "Edm.String",
                "Code": "Edm.String",
                "Parent_Key": "Edm.Guid",
                "Статус": "Edm.String",
                "DeletionMark": "Edm.Boolean",
            },
            "searchFields": ("Description", "Code"),
        },
        {
            "entity": "Catalog_ПодразделенияОрганизаций",
            "sourceType": "organization_division",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Description": "Edm.String",
                "Code": "Edm.String",
                "Owner_Key": "Edm.Guid",
                "Parent_Key": "Edm.Guid",
                "DeletionMark": "Edm.Boolean",
            },
            "searchFields": ("Description", "Code"),
        },
    ),
    "counterparty": (
        {
            "entity": "Catalog_Контрагенты",
            "sourceType": "counterparty",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Description": "Edm.String",
                "НаименованиеПолное": "Edm.String",
                "Партнер_Key": "Edm.Guid",
                "ЮридическоеФизическоеЛицо": "Edm.String",
                "DeletionMark": "Edm.Boolean",
            },
            "searchFields": ("Description", "НаименованиеПолное"),
        },
    ),
    "partner": (
        {
            "entity": "Catalog_Партнеры",
            "sourceType": "partner",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Description": "Edm.String",
                "Code": "Edm.String",
                "Клиент": "Edm.Boolean",
                "Поставщик": "Edm.Boolean",
                "DeletionMark": "Edm.Boolean",
            },
            "searchFields": ("Description", "Code"),
        },
    ),
    "contract": (
        {
            "entity": "Catalog_ДоговорыКонтрагентов",
            "sourceType": "counterparty_contract",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Description": "Edm.String",
                "Номер": "Edm.String",
                "Дата": "Edm.DateTime",
                "ДатаНачалаДействия": "Edm.DateTime",
                "ДатаОкончанияДействия": "Edm.DateTime",
                "Организация_Key": "Edm.Guid",
                "Контрагент_Key": "Edm.Guid",
                "Партнер_Key": "Edm.Guid",
                "Подразделение_Key": "Edm.Guid",
                "Статус": "Edm.String",
                "ТипДоговора": "Edm.String",
                "ХозяйственнаяОперация": "Edm.String",
                "Согласован": "Edm.Boolean",
                "DeletionMark": "Edm.Boolean",
            },
            "searchFields": ("Description", "Номер"),
        },
    ),
    "item": (
        {
            "entity": "Catalog_Номенклатура",
            "sourceType": "item",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Description": "Edm.String",
                "Code": "Edm.String",
                "Артикул": "Edm.String",
                "НаименованиеПолное": "Edm.String",
                "ЕдиницаИзмерения_Key": "Edm.Guid",
                "ТипНоменклатуры": "Edm.String",
                "DeletionMark": "Edm.Boolean",
            },
            "searchFields": (
                "Description",
                "Code",
                "Артикул",
                "НаименованиеПолное",
            ),
        },
    ),
    "warehouse": (
        {
            "entity": "Catalog_Склады",
            "sourceType": "warehouse",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Description": "Edm.String",
                "Parent_Key": "Edm.Guid",
                "IsFolder": "Edm.Boolean",
                "Подразделение_Key": "Edm.Guid",
                "ТипСклада": "Edm.String",
                "DeletionMark": "Edm.Boolean",
            },
            "searchFields": ("Description",),
        },
    ),
}

GENERAL_DOCUMENT_SPECS: dict[str, tuple[dict[str, Any], ...]] = {
    "purchase": (
        {
            "entity": "Document_ПриобретениеТоваровУслуг",
            "sourceType": "purchase",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Number": "Edm.String",
                "Date": "Edm.DateTime",
                "DeletionMark": "Edm.Boolean",
                "Posted": "Edm.Boolean",
                "Организация_Key": "Edm.Guid",
                "Подразделение_Key": "Edm.Guid",
                "Контрагент_Key": "Edm.Guid",
                "Партнер_Key": "Edm.Guid",
                "Договор_Key": "Edm.Guid",
                "Склад_Key": "Edm.Guid",
                "СуммаДокумента": "Edm.Double",
                "Комментарий": "Edm.String",
                "Товары": (
                    "Collection(StandardODATA."
                    "Document_ПриобретениеТоваровУслуг_Товары_RowType)"
                ),
            },
            "lineFields": {
                "LineNumber": "Edm.Int64",
                "Номенклатура_Key": "Edm.Guid",
                "Характеристика_Key": "Edm.Guid",
                "Количество": "Edm.Double",
                "Цена": "Edm.Double",
                "Сумма": "Edm.Double",
                "СуммаНДС": "Edm.Double",
                "Склад_Key": "Edm.Guid",
                "Подразделение_Key": "Edm.Guid",
            },
            "filters": ("period", "organization", "business_unit", "counterparty", "contract", "number", "status"),
        },
    ),
    "sale": (
        {
            "entity": "Document_РеализацияТоваровУслуг",
            "sourceType": "sale",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Number": "Edm.String",
                "Date": "Edm.DateTime",
                "DeletionMark": "Edm.Boolean",
                "Posted": "Edm.Boolean",
                "Организация_Key": "Edm.Guid",
                "Подразделение_Key": "Edm.Guid",
                "Контрагент_Key": "Edm.Guid",
                "Партнер_Key": "Edm.Guid",
                "Договор_Key": "Edm.Guid",
                "Склад_Key": "Edm.Guid",
                "СуммаДокумента": "Edm.Double",
                "Комментарий": "Edm.String",
                "Статус": "Edm.String",
                "Товары": (
                    "Collection(StandardODATA."
                    "Document_РеализацияТоваровУслуг_Товары_RowType)"
                ),
            },
            "lineFields": {
                "LineNumber": "Edm.Int64",
                "Номенклатура_Key": "Edm.Guid",
                "Характеристика_Key": "Edm.Guid",
                "Количество": "Edm.Double",
                "Цена": "Edm.Double",
                "Сумма": "Edm.Double",
                "СуммаНДС": "Edm.Double",
                "Склад_Key": "Edm.Guid",
                "Подразделение_Key": "Edm.Guid",
            },
            "filters": ("period", "organization", "business_unit", "counterparty", "contract", "number", "status"),
        },
    ),
    "receipt": (
        {
            "entity": "Document_ОприходованиеИзлишковТоваров",
            "sourceType": "surplus_receipt",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Number": "Edm.String",
                "Date": "Edm.DateTime",
                "DeletionMark": "Edm.Boolean",
                "Posted": "Edm.Boolean",
                "Организация_Key": "Edm.Guid",
                "Подразделение_Key": "Edm.Guid",
                "Склад_Key": "Edm.Guid",
                "Комментарий": "Edm.String",
                "Товары": (
                    "Collection(StandardODATA."
                    "Document_ОприходованиеИзлишковТоваров_Товары_RowType)"
                ),
            },
            "lineFields": {
                "LineNumber": "Edm.Int64",
                "Номенклатура_Key": "Edm.Guid",
                "Характеристика_Key": "Edm.Guid",
                "Количество": "Edm.Double",
                "Цена": "Edm.Double",
                "Сумма": "Edm.Double",
            },
            "filters": ("period", "organization", "business_unit", "number", "status"),
        },
    ),
    "return": (
        {
            "entity": "Document_ВозвратТоваровОтКлиента",
            "sourceType": "return_from_customer",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Number": "Edm.String",
                "Date": "Edm.DateTime",
                "DeletionMark": "Edm.Boolean",
                "Posted": "Edm.Boolean",
                "Организация_Key": "Edm.Guid",
                "Подразделение_Key": "Edm.Guid",
                "Контрагент_Key": "Edm.Guid",
                "Партнер_Key": "Edm.Guid",
                "Договор_Key": "Edm.Guid",
                "Склад_Key": "Edm.Guid",
                "СуммаДокумента": "Edm.Double",
                "Комментарий": "Edm.String",
                "Товары": (
                    "Collection(StandardODATA."
                    "Document_ВозвратТоваровОтКлиента_Товары_RowType)"
                ),
            },
            "lineFields": {
                "LineNumber": "Edm.Int64",
                "Номенклатура_Key": "Edm.Guid",
                "Характеристика_Key": "Edm.Guid",
                "Количество": "Edm.Double",
                "Цена": "Edm.Double",
                "Сумма": "Edm.Double",
                "СуммаНДС": "Edm.Double",
                "Склад_Key": "Edm.Guid",
            },
            "filters": ("period", "organization", "business_unit", "counterparty", "contract", "number", "status"),
        },
        {
            "entity": "Document_ВозвратТоваровПоставщику",
            "sourceType": "return_to_supplier",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Number": "Edm.String",
                "Date": "Edm.DateTime",
                "DeletionMark": "Edm.Boolean",
                "Posted": "Edm.Boolean",
                "Организация_Key": "Edm.Guid",
                "Подразделение_Key": "Edm.Guid",
                "Контрагент_Key": "Edm.Guid",
                "Партнер_Key": "Edm.Guid",
                "Договор_Key": "Edm.Guid",
                "Склад_Key": "Edm.Guid",
                "СуммаДокумента": "Edm.Double",
                "Комментарий": "Edm.String",
                "Товары": (
                    "Collection(StandardODATA."
                    "Document_ВозвратТоваровПоставщику_Товары_RowType)"
                ),
            },
            "lineFields": {
                "LineNumber": "Edm.Int64",
                "Номенклатура_Key": "Edm.Guid",
                "Характеристика_Key": "Edm.Guid",
                "Количество": "Edm.Double",
                "Цена": "Edm.Double",
                "Сумма": "Edm.Double",
                "СуммаНДС": "Edm.Double",
                "Склад_Key": "Edm.Guid",
            },
            "filters": ("period", "organization", "business_unit", "counterparty", "contract", "number", "status"),
        },
    ),
    "transfer": (
        {
            "entity": "Document_ПеремещениеТоваров",
            "sourceType": "stock_transfer",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Number": "Edm.String",
                "Date": "Edm.DateTime",
                "DeletionMark": "Edm.Boolean",
                "Posted": "Edm.Boolean",
                "Организация_Key": "Edm.Guid",
                "ОрганизацияПолучатель_Key": "Edm.Guid",
                "Подразделение_Key": "Edm.Guid",
                "СкладОтправитель_Key": "Edm.Guid",
                "СкладПолучатель_Key": "Edm.Guid",
                "Комментарий": "Edm.String",
                "Статус": "Edm.String",
                "Товары": (
                    "Collection(StandardODATA."
                    "Document_ПеремещениеТоваров_Товары_RowType)"
                ),
            },
            "lineFields": {
                "LineNumber": "Edm.Int64",
                "Номенклатура_Key": "Edm.Guid",
                "Характеристика_Key": "Edm.Guid",
                "Количество": "Edm.Double",
            },
            "filters": ("period", "organization", "business_unit", "number", "status"),
        },
    ),
}
GENERAL_ODATA_ENTITIES = frozenset(
    spec["entity"]
    for specs in (*GENERAL_REFERENCE_SPECS.values(), *GENERAL_DOCUMENT_SPECS.values())
    for spec in specs
)


class OneCEdoError(RuntimeError):
    """Expected user-safe runtime failure."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        exit_code: int = 2,
        diagnostic_stage: str | None = None,
        http_status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code
        self.details: dict[str, str | int] = {}
        # Diagnostics intentionally use only an enum owned by the signed
        # runtime plus the numeric status. Never include the request URL,
        # query/filter, response body, headers or credentials: 1C/proxy errors
        # may echo all of those back to the caller.
        if diagnostic_stage is not None:
            if diagnostic_stage not in DIAGNOSTIC_STAGES:
                raise ValueError("unknown fixed diagnostic stage")
            self.details["stage"] = diagnostic_stage
        if http_status is not None:
            if isinstance(http_status, bool) or not 100 <= http_status <= 599:
                raise ValueError("invalid HTTP status")
            self.details["httpStatus"] = http_status


class AuthenticationError(OneCEdoError):
    """1C rejected personal Basic Auth credentials."""


class NetworkError(OneCEdoError):
    """The fixed remote endpoint could not be reached safely."""


@dataclass(frozen=True)
class Identity:
    company_id: str
    member_id: str
    connection_id: str


@dataclass(frozen=True)
class CompanyConfig:
    odata_base_url: str
    files_base_url: str
    max_rows: int
    max_pages: int
    max_file_bytes: int
    request_timeout_seconds: float
    access_help_url: str | None
    access_instructions: str | None
    fingerprint: str


@dataclass(frozen=True)
class Credentials:
    username: str
    password: str


@dataclass(frozen=True)
class MetadataResource:
    """Bounded metadata response without exposing raw HTTP headers."""

    status: int
    body: bytes | None
    etag: str | None
    last_modified: str | None
    content_encoding: str = "identity"


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Reject every redirect so an allowed host cannot bounce credentials."""

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: BinaryIO,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        raise OneCEdoError(
            "redirect_blocked",
            "1С вернула redirect. Runtime не передаёт credentials на другой адрес.",
        )


def _utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _uuid(value: str | None, label: str) -> str:
    normalized = str(value or "").strip().lower()
    if not UUID_RE.fullmatch(normalized):
        raise OneCEdoError("invalid_identity", f"Некорректный {label}.")
    return str(uuid.UUID(normalized))


def current_skill_id() -> str:
    skill_id = str(os.environ.get("TRELIO_SKILL_ID", "")).strip()
    if skill_id not in SUPPORTED_SKILL_IDS:
        raise OneCEdoError(
            "invalid_host_context",
            "Runtime запущен не для поддерживаемой поверхности 1С.",
        )
    return skill_id


def load_identity() -> Identity:
    current_skill_id()
    return Identity(
        company_id=_uuid(os.environ.get("TRELIO_SKILL_COMPANY_ID"), "company id"),
        member_id=_uuid(os.environ.get("TRELIO_SKILL_MEMBER_ID"), "member id"),
        connection_id=_uuid(os.environ.get("TRELIO_SKILL_CONNECTION_ID"), "connection id"),
    )


def _normalize_base_url(value: Any, label: str) -> str:
    parsed = urllib.parse.urlsplit(str(value or "").strip())
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise OneCEdoError("invalid_company_config", f"{label} должен быть безопасным HTTPS URL.")
    # The backend rejects loopback/private IP literals and unsafe DNS names.
    # Runtime repeats the most important syntactic checks, then never accepts a
    # caller-supplied host or absolute URL after this point.
    if parsed.hostname.lower() in {"localhost", "localhost.localdomain"}:
        raise OneCEdoError("invalid_company_config", f"{label} не может указывать на localhost.")
    path = parsed.path if parsed.path.endswith("/") else f"{parsed.path}/"
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _bounded_integer(
    value: Any,
    label: str,
    minimum: int,
    maximum: int,
) -> int:
    if isinstance(value, bool):
        raise OneCEdoError("invalid_company_config", f"Некорректный лимит {label}.")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise OneCEdoError("invalid_company_config", f"Некорректный лимит {label}.") from error
    if parsed < minimum or parsed > maximum:
        raise OneCEdoError("invalid_company_config", f"Лимит {label} вне безопасного диапазона.")
    return parsed


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def load_company_config() -> CompanyConfig:
    raw = os.environ.get(CONNECTION_CONFIG_ENV)
    if not raw:
        raise OneCEdoError(
            "connection_not_configured",
            "Администратор компании ещё не настроил подключение 1С ЭДО.",
        )
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise OneCEdoError("invalid_company_config", "Company config содержит некорректный JSON.") from error
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise OneCEdoError("invalid_company_config", "Неподдерживаемая схема company connection.")

    normalized_for_fingerprint = {
        "schemaVersion": 1,
        "odataBaseUrl": _normalize_base_url(value.get("odataBaseUrl"), "OData URL"),
        "filesBaseUrl": _normalize_base_url(value.get("filesBaseUrl"), "Files URL"),
        "maxRows": _bounded_integer(value.get("maxRows"), "строк", 1, 200),
        "maxPages": _bounded_integer(value.get("maxPages"), "страниц", 1, 10),
        "maxFileBytes": _bounded_integer(
            value.get("maxFileBytes"),
            "размера файла",
            1,
            500 * 1024 * 1024,
        ),
        "requestTimeoutMs": _bounded_integer(
            value.get("requestTimeoutMs"),
            "таймаута",
            1_000,
            60_000,
        ),
        "accessHelpUrl": str(value.get("accessHelpUrl") or "").strip() or None,
        "accessInstructions": str(value.get("accessInstructions") or "").strip() or None,
    }
    if (
        normalized_for_fingerprint["accessHelpUrl"] is not None
        and urllib.parse.urlsplit(normalized_for_fingerprint["accessHelpUrl"]).scheme != "https"
    ):
        raise OneCEdoError("invalid_company_config", "Ссылка для запроса доступа должна быть HTTPS.")
    if (
        normalized_for_fingerprint["accessInstructions"] is not None
        and len(normalized_for_fingerprint["accessInstructions"]) > 2_000
    ):
        raise OneCEdoError("invalid_company_config", "Инструкция для доступа слишком длинная.")

    fingerprint = hashlib.sha256(
        _canonical_json(normalized_for_fingerprint).encode("utf-8"),
    ).hexdigest()
    return CompanyConfig(
        odata_base_url=normalized_for_fingerprint["odataBaseUrl"],
        files_base_url=normalized_for_fingerprint["filesBaseUrl"],
        max_rows=normalized_for_fingerprint["maxRows"],
        max_pages=normalized_for_fingerprint["maxPages"],
        max_file_bytes=normalized_for_fingerprint["maxFileBytes"],
        request_timeout_seconds=normalized_for_fingerprint["requestTimeoutMs"] / 1_000,
        access_help_url=normalized_for_fingerprint["accessHelpUrl"],
        access_instructions=normalized_for_fingerprint["accessInstructions"],
        fingerprint=fingerprint,
    )


def default_config_home() -> Path:
    override = os.environ.get("TRELIO_CONFIG_HOME")
    if override:
        return Path(override).expanduser().resolve()
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Trelio"
    return Path.home() / ".config" / "trelio"


def connection_root(identity: Identity) -> Path:
    return (
        default_config_home()
        / "integrations"
        / CREDENTIAL_PROVIDER_NAMESPACE
        / identity.company_id
        / identity.member_id
        / identity.connection_id
    )


def access_state_path(identity: Identity) -> Path:
    return connection_root(identity) / "config" / "access.json"


def credentials_path(identity: Identity) -> Path:
    return connection_root(identity) / "secrets" / "personal-basic-auth.json"


def general_schema_cache_path(identity: Identity) -> Path:
    """Return the identity-scoped cache path shared by both 1C surfaces."""

    return connection_root(identity) / "cache" / "broad-schema-v1.json"


def general_schema_cache_lock_path(identity: Identity) -> Path:
    return connection_root(identity) / "cache" / "broad-schema-v1.lock"


def _assert_not_symlink(path: Path) -> None:
    with contextlib.suppress(FileNotFoundError):
        if stat.S_ISLNK(path.lstat().st_mode):
            raise OneCEdoError("unsafe_local_storage", f"Локальный путь {path} не может быть symlink.")


def _apply_windows_private_acl(path: Path, *, directory: bool) -> None:
    if os.name != "nt":
        return
    current_user = getpass.getuser()
    inheritance = "(OI)(CI)F" if directory else "F"
    result = subprocess.run(
        [
            "icacls",
            str(path),
            "/inheritance:r",
            "/grant:r",
            f"{current_user}:{inheritance}",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise OneCEdoError(
            "unsafe_local_storage",
            "Не удалось выставить приватный Windows ACL для локальных данных 1С.",
        )


def ensure_private_directory(path: Path) -> None:
    """Create/check namespace components without traversing a local symlink.

    We enforce the boundary from ``integrations`` downward. The user's config
    home itself may legitimately be a managed filesystem mount, but no skill,
    company, member or connection component may redirect storage elsewhere.
    """

    integration_root = default_config_home() / "integrations"
    current = integration_root
    for component in path.relative_to(integration_root).parts:
        _assert_not_symlink(current)
        current.mkdir(mode=0o700, parents=True, exist_ok=True)
        if os.name == "posix":
            current.chmod(0o700)
        _apply_windows_private_acl(current, directory=True)
        current = current / component
    _assert_not_symlink(current)
    current.mkdir(mode=0o700, parents=False, exist_ok=True)
    if os.name == "posix":
        current.chmod(0o700)
    _apply_windows_private_acl(current, directory=True)


def _read_private_json(path: Path) -> dict[str, Any] | None:
    _assert_not_symlink(path)
    if not path.exists():
        return None
    if os.name == "posix" and path.stat().st_mode & 0o077:
        raise OneCEdoError("unsafe_local_storage", f"Небезопасные права локального файла {path}.")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise OneCEdoError("invalid_local_state", f"Не удалось прочитать локальное состояние {path}.") from error
    if not isinstance(value, dict):
        raise OneCEdoError("invalid_local_state", f"Локальное состояние {path} повреждено.")
    return value


def _write_private_json(path: Path, value: dict[str, Any]) -> None:
    ensure_private_directory(path.parent)
    _assert_not_symlink(path)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        if os.name == "posix":
            os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        _apply_windows_private_acl(temporary, directory=False)
        os.replace(temporary, path)
        if os.name == "posix":
            path.chmod(0o600)
            directory_descriptor = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
        _apply_windows_private_acl(path, directory=False)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()


def _delete_private_file(path: Path) -> bool:
    _assert_not_symlink(path)
    if not path.exists():
        return False
    path.unlink()
    return True


@contextlib.contextmanager
def _exclusive_private_file_lock(path: Path) -> Iterable[None]:
    """Serialize cache refreshes across one-shot runtime processes.

    The lock never carries data or credentials.  It only prevents two
    simultaneous commands from downloading the same large metadata document.
    A bounded wait fails closed rather than bypassing schema validation.
    """

    ensure_private_directory(path.parent)
    _assert_not_symlink(path)
    flags = os.O_CREAT | os.O_RDWR
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as error:
        raise OneCEdoError(
            "unsafe_local_storage",
            "Не удалось безопасно открыть локальную блокировку metadata cache.",
        ) from error
    deadline = time.monotonic() + GENERAL_SCHEMA_CACHE_LOCK_TIMEOUT_SECONDS
    locked = False
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise OneCEdoError(
                "unsafe_local_storage",
                "Локальная блокировка metadata cache должна быть обычным файлом.",
            )
        if os.name == "posix":
            os.fchmod(descriptor, 0o600)
            import fcntl

            while True:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    locked = True
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise OneCEdoError(
                            "metadata_cache_busy",
                            "Другая проверка metadata не завершилась вовремя.",
                        )
                    time.sleep(0.1)
        elif os.name == "nt":
            import msvcrt

            if metadata.st_size == 0:
                os.write(descriptor, b"\0")
            while True:
                try:
                    os.lseek(descriptor, 0, os.SEEK_SET)
                    msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
                    locked = True
                    break
                except OSError as error:
                    if error.errno not in {errno.EACCES, errno.EAGAIN}:
                        raise
                    if time.monotonic() >= deadline:
                        raise OneCEdoError(
                            "metadata_cache_busy",
                            "Другая проверка metadata не завершилась вовремя.",
                        )
                    time.sleep(0.1)
        else:
            raise OneCEdoError(
                "unsafe_local_storage",
                "Платформа не поддерживает безопасную блокировку metadata cache.",
            )
        yield
    finally:
        if locked and os.name == "posix":
            with contextlib.suppress(OSError):
                import fcntl

                fcntl.flock(descriptor, fcntl.LOCK_UN)
        elif locked and os.name == "nt":
            with contextlib.suppress(OSError):
                import msvcrt

                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        os.close(descriptor)


def load_access_state(identity: Identity, config: CompanyConfig) -> dict[str, Any]:
    value = _read_private_json(access_state_path(identity))
    if not value or value.get("fingerprint") != config.fingerprint:
        # A user choice of "no access" is meaningful only for the exact
        # company connection. Changing host, path or safety limits resets the
        # decision to unknown and prevents old credentials from being reused.
        return {
            "status": "unknown",
            "fingerprint": config.fingerprint,
            "connectionChanged": bool(value),
        }
    status_value = value.get("status")
    if status_value not in ACCESS_STATES:
        raise OneCEdoError("invalid_local_state", "Локальный access status повреждён.")
    if status_value == "connected":
        credentials = _read_private_json(credentials_path(identity))
        if not credentials or credentials.get("fingerprint") != config.fingerprint:
            return {
                "status": "needs_reconnect",
                "fingerprint": config.fingerprint,
                "connectionChanged": False,
            }
    return {
        "status": status_value,
        "fingerprint": config.fingerprint,
        "connectionChanged": False,
    }


def save_access_state(identity: Identity, config: CompanyConfig, status_value: str) -> None:
    if status_value not in ACCESS_STATES:
        raise OneCEdoError("invalid_access_state", "Неподдерживаемый access status.")
    _write_private_json(
        access_state_path(identity),
        {
            "schemaVersion": 1,
            "fingerprint": config.fingerprint,
            "status": status_value,
            "updatedAt": _utc_now(),
        },
    )


def load_credentials(identity: Identity, config: CompanyConfig) -> Credentials:
    value = _read_private_json(credentials_path(identity))
    if not value or value.get("fingerprint") != config.fingerprint:
        raise OneCEdoError(
            "credentials_missing",
            "Личные данные 1С не подключены для текущей company connection.",
        )
    username = value.get("username")
    password = value.get("password")
    if not isinstance(username, str) or not username or not isinstance(password, str) or not password:
        raise OneCEdoError("invalid_local_state", "Локальный credential-файл повреждён.")
    return Credentials(username=username, password=password)


def save_credentials(
    identity: Identity,
    config: CompanyConfig,
    credentials: Credentials,
) -> None:
    # A protected reconnect can change the metadata visibility of the same
    # endpoint.  Remove the old attestation before persisting the new
    # credentials so it can never be revalidated under another identity.
    _delete_private_file(general_schema_cache_path(identity))
    _write_private_json(
        credentials_path(identity),
        {
            "schemaVersion": 1,
            "fingerprint": config.fingerprint,
            "username": credentials.username,
            "password": credentials.password,
            "updatedAt": _utc_now(),
        },
    )


def _prompt_credentials_terminal() -> Credentials:
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        raise OneCEdoError(
            "protected_prompt_unavailable",
            "Для connect нужен локальный интерактивный терминал или системное окно.",
        )
    username = input("Логин 1С: ").strip()
    password = getpass.getpass("Пароль 1С: ")
    if not username or not password:
        raise OneCEdoError("credentials_empty", "Логин и пароль 1С не могут быть пустыми.")
    return Credentials(username=username, password=password)


def _prompt_credentials_macos() -> Credentials | None:
    if sys.platform != "darwin" or not shutil.which("osascript"):
        return None
    script = """
set usernameAnswer to display dialog "Введите личный логин 1С. Он останется только на этом компьютере." default answer "" with title "Trelio – 1С ЭДО" buttons {"Отмена", "Продолжить"} default button "Продолжить" cancel button "Отмена"
set passwordAnswer to display dialog "Введите личный пароль 1С." default answer "" with hidden answer with title "Trelio – 1С ЭДО" buttons {"Отмена", "Подключить"} default button "Подключить" cancel button "Отмена"
return (text returned of usernameAnswer) & linefeed & (text returned of passwordAnswer)
"""
    result = subprocess.run(
        ["osascript", "-e", script],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise OneCEdoError("connect_cancelled", "Подключение отменено пользователем.")
    username, separator, password = result.stdout.rstrip("\n").partition("\n")
    if not separator or not username.strip() or not password:
        raise OneCEdoError("credentials_empty", "Логин и пароль 1С не могут быть пустыми.")
    return Credentials(username=username.strip(), password=password)


def _prompt_credentials_windows() -> Credentials | None:
    if os.name != "nt" or not shutil.which("powershell.exe"):
        return None
    # The script is constant and contains no credential values. The password
    # crosses only a private parent/child pipe and is never placed in argv.
    script = r"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object Windows.Forms.Form
$form.Text = 'Trelio – 1С ЭДО'
$form.Size = New-Object Drawing.Size(430,220)
$form.StartPosition = 'CenterScreen'
$login = New-Object Windows.Forms.TextBox
$login.Location = New-Object Drawing.Point(20,45)
$login.Width = 370
$password = New-Object Windows.Forms.TextBox
$password.Location = New-Object Drawing.Point(20,105)
$password.Width = 370
$password.UseSystemPasswordChar = $true
$ok = New-Object Windows.Forms.Button
$ok.Text = 'Подключить'
$ok.Location = New-Object Drawing.Point(290,145)
$ok.DialogResult = [Windows.Forms.DialogResult]::OK
$form.Controls.AddRange(@($login,$password,$ok))
$form.AcceptButton = $ok
if ($form.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { exit 3 }
@{username=$login.Text;password=$password.Text} | ConvertTo-Json -Compress
"""
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise OneCEdoError("connect_cancelled", "Подключение отменено пользователем.")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise OneCEdoError("protected_prompt_failed", "Системное окно не вернуло credentials.") from error
    username = str(value.get("username") or "").strip()
    password = str(value.get("password") or "")
    if not username or not password:
        raise OneCEdoError("credentials_empty", "Логин и пароль 1С не могут быть пустыми.")
    return Credentials(username=username, password=password)


def prompt_credentials() -> Credentials:
    return (
        _prompt_credentials_macos()
        or _prompt_credentials_windows()
        or _prompt_credentials_terminal()
    )


def _require_x_odata() -> str:
    value = os.environ.get(X_ODATA_ENV)
    if not value or len(value) < 16 or len(value) > 1_024 or "\n" in value or "\r" in value:
        raise OneCEdoError(
            "x_odata_missing",
            "Нужен одноразовый checkout company Agent Secret с binding x_odata.",
        )
    return value


def _basic_auth(credentials: Credentials) -> str:
    raw = f"{credentials.username}:{credentials.password}".encode("utf-8")
    return f"Basic {base64.b64encode(raw).decode('ascii')}"


def _odata_query(parameters: Iterable[tuple[str, str | int]]) -> str:
    """Encode OData query with `%20`, never form-style `+`.

    Parentheses, commas and single quotes are syntax generated exclusively by
    this runtime. User input is reduced to validated UUIDs before reaching a
    filter, so the safe set cannot enable arbitrary OData expressions.
    """

    encoded: list[str] = []
    for key, value in parameters:
        encoded_key = urllib.parse.quote(str(key), safe="$")
        encoded_value = urllib.parse.quote(str(value), safe="'(),")
        encoded.append(f"{encoded_key}={encoded_value}")
    return "&".join(encoded)


def _odata_url(
    config: CompanyConfig,
    entity: str,
    parameters: Iterable[tuple[str, str | int]] = (),
) -> str:
    allowed = {
        *DOCUMENT_ENTITIES.values(),
        CONTRACT_ENTITY,
        *BUSINESS_ENTITY_SPECS,
        STATUS_REGISTER_ENTITY,
        NEW_FILE_ENTITY,
        OLD_MESSAGE_ENTITY,
        OLD_FILE_ENTITY,
        *GENERAL_ODATA_ENTITIES,
    }
    if entity not in allowed:
        raise OneCEdoError("entity_blocked", "Эта OData entity не разрешена runtime.")
    url = f"{config.odata_base_url}{urllib.parse.quote(entity, safe='_')}"
    query = _odata_query(parameters)
    return f"{url}?{query}" if query else url


def _file_url(config: CompanyConfig, scheme: str, file_id: str) -> str:
    metadata = FILE_METADATA.get(scheme)
    if metadata is None:
        raise OneCEdoError("file_path_blocked", "Разрешены только new и old file routes.")
    normalized_id = _uuid(file_id, "file id")
    return (
        f"{config.files_base_url}"
        f"{urllib.parse.quote(metadata, safe='')}/{normalized_id}"
    )


def _http_open(
    method: str,
    url: str,
    *,
    credentials: Credentials,
    timeout: float,
    x_odata: str | None,
    diagnostic_stage: str,
    accept: str | None = None,
    accept_encoding: str | None = None,
    conditional_headers: Mapping[str, str] | None = None,
    allow_not_modified: bool = False,
) -> Any:
    if diagnostic_stage not in DIAGNOSTIC_STAGES:
        raise OneCEdoError(
            "query_builder_error",
            "Внутренний запрос не имеет разрешённого diagnostic stage.",
        )
    if method not in {"GET", "HEAD"}:
        raise OneCEdoError("method_blocked", "Runtime разрешает только GET и HEAD.")
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" and not (
        os.environ.get("TRELIO_1C_EDO_TEST_ALLOW_HTTP") == "1"
        and parsed.hostname in {"127.0.0.1", "::1"}
    ):
        raise OneCEdoError("url_blocked", "Runtime разрешает только HTTPS endpoint.")
    try:
        resolved = socket.getaddrinfo(
            parsed.hostname,
            parsed.port or 443,
            type=socket.SOCK_STREAM,
        )
    except socket.gaierror as error:
        raise NetworkError(
            "network_error",
            "DNS endpoint 1С недоступен.",
            diagnostic_stage=diagnostic_stage,
        ) from error
    for address in resolved:
        ip_value = ipaddress.ip_address(address[4][0])
        if not ip_value.is_global:
            raise OneCEdoError(
                "url_blocked",
                "Endpoint 1С разрешился в непубличный сетевой адрес.",
            )
    headers = {
        "Accept": accept or ("application/json" if x_odata else "*/*"),
        "Authorization": _basic_auth(credentials),
        "User-Agent": f"Trelio-1C/{RUNTIME_VERSION}",
    }
    if x_odata is not None:
        headers["X-OData"] = x_odata
    if accept_encoding is not None:
        # Compression is allowed only for the fixed metadata route. Keep the
        # accepted token closed so this helper cannot become an arbitrary
        # content-negotiation surface.
        if accept_encoding != METADATA_ACCEPT_ENCODING:
            raise OneCEdoError(
                "query_builder_error",
                "Runtime отклонила неподдерживаемое кодирование ответа.",
            )
        headers["Accept-Encoding"] = accept_encoding
    for name, value in (conditional_headers or {}).items():
        # Conditional headers can originate only from the private,
        # integrity-protected metadata cache. Repeat a strict allowlist and
        # newline/size check here so a corrupted local file cannot become a
        # generic header-injection primitive.
        if name not in {"If-None-Match", "If-Modified-Since"}:
            raise OneCEdoError(
                "query_builder_error",
                "Runtime отклонила неподдерживаемый conditional header.",
            )
        if (
            not isinstance(value, str)
            or not value
            or len(value) > MAX_METADATA_ETAG_CHARS
            or "\r" in value
            or "\n" in value
        ):
            raise OneCEdoError(
                "invalid_local_state",
                "Локальный metadata validator повреждён.",
            )
        headers[name] = value
    request = urllib.request.Request(url, headers=headers, method=method)
    opener = urllib.request.build_opener(
        NoRedirectHandler(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
    )
    try:
        return opener.open(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        if allow_not_modified and error.code == 304:
            # urllib represents a valid conditional response as HTTPError.
            # The caller receives only the status and safe validator
            # availability; neither header values nor request details are
            # serialized to the agent.
            return error
        if error.code in {401, 403}:
            raise AuthenticationError(
                "authentication_failed",
                "1С отклонила личный логин/пароль или доступ к endpoint.",
                diagnostic_stage=diagnostic_stage,
                http_status=error.code,
            ) from error
        if 300 <= error.code < 400:
            raise OneCEdoError(
                "redirect_blocked",
                "Redirect от 1С заблокирован.",
                diagnostic_stage=diagnostic_stage,
                http_status=error.code,
            ) from error
        raise NetworkError(
            "http_error",
            f"1С отклонила фиксированный запрос: HTTP {error.code}.",
            diagnostic_stage=diagnostic_stage,
            http_status=error.code,
        ) from error
    except (urllib.error.URLError, TimeoutError, socket.timeout, ssl.SSLError) as error:
        raise NetworkError(
            "network_error",
            "Не удалось безопасно связаться с 1С.",
            diagnostic_stage=diagnostic_stage,
        ) from error


def _read_limited(stream: BinaryIO, limit: int) -> bytes:
    value = stream.read(limit + 1)
    if len(value) > limit:
        raise OneCEdoError("response_too_large", "Ответ 1С превысил безопасный лимит.")
    return value


def _request_odata(
    config: CompanyConfig,
    credentials: Credentials,
    entity: str,
    parameters: Iterable[tuple[str, str | int]] = (),
    *,
    diagnostic_stage: str,
) -> dict[str, Any]:
    url = _odata_url(config, entity, parameters)
    response = _http_open(
        "GET",
        url,
        credentials=credentials,
        timeout=config.request_timeout_seconds,
        x_odata=_require_x_odata(),
        diagnostic_stage=diagnostic_stage,
    )
    with response:
        raw = _read_limited(response, MAX_ODATA_RESPONSE_BYTES)
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise OneCEdoError("invalid_odata_response", "1С вернула некорректный JSON.") from error
    if not isinstance(value, dict):
        raise OneCEdoError("invalid_odata_response", "1С вернула неожиданный OData payload.")
    return value


def _metadata_url(config: CompanyConfig) -> str:
    """Return the single fixed metadata URL.

    The caller cannot supply a URL or path.  This command exists only in the
    development release of the broad `1c` skill and never returns raw XML.
    """

    return f"{config.odata_base_url}$metadata"


def _safe_metadata_validators(headers: Any) -> tuple[str | None, str | None]:
    """Extract only syntactically safe validators for a later conditional GET.

    Header values stay in the private cache and are never returned in the
    runtime JSON. Unsupported or malformed values are ignored, causing the
    next broad command to perform another complete metadata verification.
    """

    raw_etag = headers.get("ETag") if headers is not None else None
    etag = str(raw_etag).strip() if raw_etag is not None else ""
    if (
        not etag
        or len(etag) > MAX_METADATA_ETAG_CHARS
        or not METADATA_ETAG_RE.fullmatch(etag)
    ):
        etag = ""

    raw_last_modified = (
        headers.get("Last-Modified") if headers is not None else None
    )
    last_modified = (
        str(raw_last_modified).strip()
        if raw_last_modified is not None
        else ""
    )
    if (
        not last_modified
        or len(last_modified) > MAX_METADATA_LAST_MODIFIED_CHARS
        or "\r" in last_modified
        or "\n" in last_modified
    ):
        last_modified = ""
    else:
        try:
            if email.utils.parsedate_to_datetime(last_modified) is None:
                last_modified = ""
        except (TypeError, ValueError, OverflowError):
            last_modified = ""
    return etag or None, last_modified or None


def _safe_metadata_content_encoding(headers: Any) -> str:
    """Return a fixed transfer-encoding enum or fail closed.

    The runtime deliberately requests only gzip. Unknown, chained or malformed
    content encodings are not guessed and the raw header value never leaves
    this function.
    """

    raw = headers.get("Content-Encoding") if headers is not None else None
    if raw is None:
        return "identity"
    value = str(raw).strip().lower()
    if value in {"", "identity"}:
        return "identity"
    if value == METADATA_ACCEPT_ENCODING:
        return "gzip"
    raise OneCEdoError(
        "invalid_metadata_response",
        "1С вернула неподдерживаемое кодирование metadata.",
    )


def _read_gzip_limited(stream: BinaryIO, limit: int) -> bytes:
    """Decode one gzip member with independent wire and output limits."""

    decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS)
    output = bytearray()
    compressed_bytes = 0
    while True:
        chunk = stream.read(64 * 1024)
        if not chunk:
            break
        compressed_bytes += len(chunk)
        if compressed_bytes > limit:
            raise OneCEdoError(
                "response_too_large",
                "Сжатый metadata-ответ превысил безопасный лимит.",
            )
        remaining = limit + 1 - len(output)
        try:
            output.extend(decompressor.decompress(chunk, remaining))
        except zlib.error as error:
            raise OneCEdoError(
                "invalid_metadata_response",
                "1С вернула повреждённый gzip metadata.",
            ) from error
        if len(output) > limit or decompressor.unconsumed_tail:
            raise OneCEdoError(
                "response_too_large",
                "Распакованный metadata-ответ превысил безопасный лимит.",
            )
        if decompressor.unused_data:
            # HTTP Content-Encoding should describe one representation. Reject
            # concatenated members/trailing bytes instead of silently ignoring
            # an ambiguous second payload.
            raise OneCEdoError(
                "invalid_metadata_response",
                "1С вернула неоднозначный gzip metadata.",
            )
    try:
        output.extend(decompressor.flush(limit + 1 - len(output)))
    except zlib.error as error:
        raise OneCEdoError(
            "invalid_metadata_response",
            "1С вернула повреждённый gzip metadata.",
        ) from error
    if not decompressor.eof:
        raise OneCEdoError(
            "invalid_metadata_response",
            "1С вернула незавершённый gzip metadata.",
        )
    if len(output) > limit:
        raise OneCEdoError(
            "response_too_large",
            "Распакованный metadata-ответ превысил безопасный лимит.",
        )
    return bytes(output)


def _request_metadata_resource(
    config: CompanyConfig,
    credentials: Credentials,
    *,
    validators: Mapping[str, str] | None = None,
    diagnostic_stage: str = "metadata.inventory.fetch",
) -> MetadataResource:
    conditional_headers: dict[str, str] = {}
    if validators:
        etag = validators.get("etag")
        last_modified = validators.get("lastModified")
        if etag:
            conditional_headers["If-None-Match"] = etag
        if last_modified:
            conditional_headers["If-Modified-Since"] = last_modified
    response = _http_open(
        "GET",
        _metadata_url(config),
        credentials=credentials,
        timeout=config.request_timeout_seconds,
        x_odata=_require_x_odata(),
        diagnostic_stage=diagnostic_stage,
        accept="application/xml",
        accept_encoding=METADATA_ACCEPT_ENCODING,
        conditional_headers=conditional_headers,
        allow_not_modified=bool(conditional_headers),
    )
    with response:
        status_code = int(
            getattr(response, "status", None)
            or getattr(response, "code", None)
            or response.getcode(),
        )
        etag, last_modified = _safe_metadata_validators(response.headers)
        content_encoding = _safe_metadata_content_encoding(response.headers)
        if status_code == 304:
            return MetadataResource(
                status=304,
                body=None,
                etag=etag,
                last_modified=last_modified,
                content_encoding="identity",
            )
        body = (
            _read_gzip_limited(response, MAX_METADATA_RESPONSE_BYTES)
            if content_encoding == "gzip"
            else _read_limited(response, MAX_METADATA_RESPONSE_BYTES)
        )
        return MetadataResource(
            status=status_code,
            body=body,
            etag=etag,
            last_modified=last_modified,
            content_encoding=content_encoding,
        )


def _request_metadata(
    config: CompanyConfig,
    credentials: Credentials,
    *,
    diagnostic_stage: str = "metadata.inventory.fetch",
) -> bytes:
    resource = _request_metadata_resource(
        config,
        credentials,
        diagnostic_stage=diagnostic_stage,
    )
    if resource.status != 200 or resource.body is None:
        raise OneCEdoError(
            "invalid_metadata_response",
            "1С вернула неожиданный ответ metadata.",
        )
    return resource.body


def _xml_local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _inventory_entity_rank(
    candidate: dict[str, Any],
    capability: tuple[str, str],
) -> tuple[int, int, int, int, str]:
    """Rank fixed business candidates without relying on metadata order.

    Exact conventional names are only discovery hints: they do not become a
    production mapping until the returned schema and sample have been reviewed.
    Base entities rank ahead of tabular parts and auxiliary catalogs so a large
    family such as `Номенклатура` cannot crowd out another capability.
    """

    name = str(candidate["entitySet"])
    preferred = INVENTORY_PREFERRED_ENTITIES.get(capability, ())
    preferred_index = preferred.index(name) if name in preferred else len(preferred)
    suffix = name.split("_", 1)[1] if "_" in name else name
    is_auxiliary = "_" in suffix or name.endswith("ПрисоединенныеФайлы")
    return (
        0 if name in preferred else 1,
        preferred_index,
        1 if is_auxiliary else 0,
        len(name),
        name,
    )


def _metadata_candidates(
    raw: bytes,
) -> tuple[str, list[dict[str, Any]], bool, dict[str, dict[str, int | bool]]]:
    """Parse a bounded structural inventory from 1C metadata.

    Only names and declared EDM types from business-oriented candidates leave
    the process. Raw metadata, annotations and unrelated entities (including
    HR, payroll, banking, cash and accounting internals) are never serialized.
    """

    try:
        root = ET.fromstring(raw)
    except ET.ParseError as error:
        raise OneCEdoError(
            "invalid_metadata_response",
            "1С вернула некорректный XML metadata.",
        ) from error

    entity_types: dict[str, dict[str, Any]] = {}
    for schema in (element for element in root.iter() if _xml_local_name(element.tag) == "Schema"):
        namespace = str(schema.attrib.get("Namespace") or "")
        for entity_type in (
            child for child in schema
            if _xml_local_name(child.tag) in {"EntityType", "ComplexType"}
        ):
            type_name = str(entity_type.attrib.get("Name") or "")
            if not type_name:
                continue
            properties: list[dict[str, Any]] = []
            navigations: list[dict[str, str]] = []
            for child in entity_type:
                local_name = _xml_local_name(child.tag)
                if local_name == "Property":
                    property_name = str(child.attrib.get("Name") or "")
                    property_type = str(child.attrib.get("Type") or "")
                    if property_name and property_type:
                        properties.append({
                            "name": property_name[:128],
                            "type": property_type[:160],
                            "nullable": child.attrib.get("Nullable") != "false",
                        })
                elif local_name == "NavigationProperty":
                    navigation_name = str(child.attrib.get("Name") or "")
                    navigation_type = str(child.attrib.get("Type") or "")
                    if navigation_name and navigation_type:
                        navigations.append({
                            "name": navigation_name[:128],
                            "type": navigation_type[:160],
                        })
            normalized = {
                "properties": properties[:MAX_INVENTORY_PROPERTIES],
                "propertiesTruncated": len(properties) > MAX_INVENTORY_PROPERTIES,
                "navigationProperties": navigations[:MAX_INVENTORY_PROPERTIES],
                "navigationPropertiesTruncated": len(navigations) > MAX_INVENTORY_PROPERTIES,
            }
            entity_types[type_name] = normalized
            if namespace:
                entity_types[f"{namespace}.{type_name}"] = normalized

    grouped: dict[str, dict[str, Any]] = {}
    for entity_set in (
        element for element in root.iter()
        if _xml_local_name(element.tag) == "EntitySet"
    ):
        name = str(entity_set.attrib.get("Name") or "")
        entity_type_name = str(entity_set.attrib.get("EntityType") or "")
        if (
            not name
            or any(term.casefold() in name.casefold() for term in INVENTORY_BLOCKED_TERMS)
        ):
            continue
        matches: list[dict[str, str]] = []
        if name.startswith("Catalog_"):
            for kind, terms in INVENTORY_REFERENCE_TERMS.items():
                if any(term.casefold() in name.casefold() for term in terms):
                    matches.append({"section": "reference", "kind": kind})
        elif name.startswith("Document_"):
            for kind, terms in INVENTORY_DOCUMENT_TERMS.items():
                if any(term.casefold() in name.casefold() for term in terms):
                    matches.append({"section": "document", "kind": kind})
        elif name.startswith(("AccumulationRegister_", "InformationRegister_")):
            if (
                "Остат".casefold() in name.casefold()
                and any(term.casefold() in name.casefold() for term in INVENTORY_STOCK_TERMS[1:])
            ):
                matches.append({"section": "balance", "kind": "stock"})

        if not matches:
            continue
        grouped[name] = {
            "entitySet": name,
            "entityType": entity_type_name[:240],
            "matches": matches,
            **entity_types.get(entity_type_name, {
                "properties": [],
                "propertiesTruncated": False,
                "navigationProperties": [],
                "navigationPropertiesTruncated": False,
            }),
        }
        collections: list[dict[str, Any]] = []
        for property_item in grouped[name]["properties"]:
            property_type = str(property_item.get("type") or "")
            if not (
                property_type.startswith("Collection(")
                and property_type.endswith(")")
            ):
                continue
            row_type_name = property_type[len("Collection("):-1]
            row_definition = entity_types.get(row_type_name)
            collections.append({
                "name": str(property_item.get("name") or "")[:128],
                "rowType": row_type_name[:240],
                "properties": (
                    row_definition.get("properties", [])
                    if row_definition is not None
                    else []
                )[:MAX_INVENTORY_PROPERTIES],
                "propertiesTruncated": bool(
                    row_definition and row_definition.get("propertiesTruncated")
                ),
            })
        grouped[name]["collections"] = collections[:32]
        grouped[name]["collectionsTruncated"] = len(collections) > 32

    selected: dict[str, dict[str, Any]] = {}
    capability_counts: dict[str, dict[str, int | bool]] = {}
    capabilities = sorted({
        (str(match["section"]), str(match["kind"]))
        for candidate in grouped.values()
        for match in candidate["matches"]
    })
    truncated = False
    for capability in capabilities:
        matches = [
            candidate
            for candidate in grouped.values()
            if {
                "section": capability[0],
                "kind": capability[1],
            } in candidate["matches"]
        ]
        matches.sort(key=lambda candidate: _inventory_entity_rank(candidate, capability))
        limited = matches[:MAX_INVENTORY_ENTITIES_PER_CAPABILITY]
        capability_key = f"{capability[0]}.{capability[1]}"
        capability_counts[capability_key] = {
            "matched": len(matches),
            "returned": len(limited),
            "truncated": len(matches) > len(limited),
        }
        truncated = truncated or len(matches) > len(limited)
        for candidate in limited:
            selected[str(candidate["entitySet"])] = candidate

    ordered = sorted(
        selected.values(),
        key=lambda item: str(item["entitySet"]),
    )
    if len(ordered) > MAX_INVENTORY_ENTITIES:
        ordered = ordered[:MAX_INVENTORY_ENTITIES]
        truncated = True
    return (
        hashlib.sha256(raw).hexdigest(),
        ordered,
        truncated,
        capability_counts,
    )


def _inventory_sample_names(candidates: list[dict[str, Any]]) -> set[str]:
    """Choose a bounded sample set independently for every capability."""

    selected: set[str] = set()
    capabilities = sorted({
        (str(match["section"]), str(match["kind"]))
        for candidate in candidates
        for match in candidate["matches"]
    })
    for capability in capabilities:
        matches = [
            candidate
            for candidate in candidates
            if {
                "section": capability[0],
                "kind": capability[1],
            } in candidate["matches"]
        ]
        matches.sort(key=lambda candidate: _inventory_entity_rank(candidate, capability))
        selected.update(
            str(candidate["entitySet"])
            for candidate in matches[:MAX_INVENTORY_SAMPLES_PER_CAPABILITY]
        )
    return selected


def _inventory_sample_fields(candidate: dict[str, Any]) -> list[str]:
    property_names = [
        str(item.get("name") or "")
        for item in candidate.get("properties", [])
        if isinstance(item, dict)
    ]
    preferred = [
        "Ref_Key",
        "Description",
        "Code",
        "Number",
        "Date",
        "Posted",
        "DeletionMark",
    ]
    relations = [
        name for name in property_names
        if name.endswith("_Key")
        and not any(term.casefold() in name.casefold() for term in INVENTORY_BLOCKED_TERMS)
    ][:12]
    statuses = [
        name for name in property_names
        if any(term in name.casefold() for term in ("статус", "состояни"))
    ][:4]
    selected: list[str] = []
    for name in [*preferred, *relations, *statuses]:
        if name in property_names and name not in selected:
            selected.append(name)
    return selected[:24]


def _inventory_sample_value_class(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        if UUID_RE.fullmatch(value):
            return "uuid"
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}T.*", value):
            return "datetime"
        return "string"
    return "non_scalar"


def _request_inventory_sample(
    config: CompanyConfig,
    credentials: Credentials,
    candidate: dict[str, Any],
) -> dict[str, Any]:
    entity = str(candidate["entitySet"])
    fields = _inventory_sample_fields(candidate)
    # The entity name comes only from the already parsed metadata and is
    # additionally constrained by fixed business prefixes/patterns above.
    # No CLI value can reach this URL builder.
    url = f"{config.odata_base_url}{urllib.parse.quote(entity, safe='_')}"
    parameters: list[tuple[str, str | int]] = [("$top", 1)]
    if fields:
        parameters.append(("$select", ",".join(fields)))
    response = _http_open(
        "GET",
        f"{url}?{_odata_query(parameters)}",
        credentials=credentials,
        timeout=config.request_timeout_seconds,
        x_odata=_require_x_odata(),
        diagnostic_stage="metadata.inventory.sample",
    )
    with response:
        raw = _read_limited(response, min(MAX_ODATA_RESPONSE_BYTES, 512 * 1024))
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise OneCEdoError(
            "invalid_odata_response",
            "1С вернула некорректный sample JSON.",
        ) from error
    if not isinstance(value, dict):
        raise OneCEdoError(
            "invalid_odata_response",
            "1С вернула неожиданный sample payload.",
        )
    rows = _odata_rows(value)
    first = rows[0] if rows else {}
    return {
        "accessible": True,
        "hasRows": bool(rows),
        "selectedFields": fields,
        "returnedFieldClasses": {
            field: _inventory_sample_value_class(first.get(field))
            for field in fields
            if field in first
        },
    }


def command_developer_inventory_metadata(_: argparse.Namespace) -> dict[str, Any]:
    """Inspect only bounded structural candidates through the signed runtime."""

    identity, config, credentials = _connected_context()
    try:
        raw = _request_metadata(config, credentials)
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    schema_digest, candidates, truncated, capability_counts = _metadata_candidates(raw)
    sample_names = _inventory_sample_names(candidates)
    for candidate in candidates:
        if str(candidate["entitySet"]) not in sample_names:
            candidate["sample"] = {
                "sampled": False,
                "reason": "per_capability_limit",
            }
            continue
        try:
            candidate["sample"] = _request_inventory_sample(
                config,
                credentials,
                candidate,
            )
        except AuthenticationError:
            _mark_auth_failure(identity, config)
            raise
        except OneCEdoError as error:
            candidate["sample"] = {
                "accessible": False,
                "error": _safe_error_payload(error),
            }
    return {
        "inventoryVersion": 1,
        "schemaDigest": f"sha256:{schema_digest}",
        "candidateCount": len(candidates),
        "candidatesTruncated": truncated,
        "capabilityCounts": capability_counts,
        "candidates": candidates,
        "limits": {
            "maxEntities": MAX_INVENTORY_ENTITIES,
            "maxEntitiesPerCapability": MAX_INVENTORY_ENTITIES_PER_CAPABILITY,
            "maxPropertiesPerEntity": MAX_INVENTORY_PROPERTIES,
            "maxSamplesPerCapability": MAX_INVENTORY_SAMPLES_PER_CAPABILITY,
            "sampleRowsPerEntity": 1,
        },
    }


def _odata_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    raw_rows = payload.get("value")
    if raw_rows is None and isinstance(payload.get("d"), dict):
        raw_rows = payload["d"].get("results")
    if raw_rows is None:
        raw_rows = []
    if not isinstance(raw_rows, list):
        raise OneCEdoError("invalid_odata_response", "OData rows имеют неожиданный формат.")
    return [row for row in raw_rows if isinstance(row, dict)]


def _safe_scalar_record(value: dict[str, Any]) -> dict[str, Any]:
    """Return only bounded scalars so backend internals cannot flood the agent."""

    result: dict[str, Any] = {}
    for key, item in value.items():
        if not isinstance(key, str) or len(key) > 128:
            continue
        if item is None or isinstance(item, (bool, int, float)):
            result[key] = item
        elif isinstance(item, str):
            result[key] = item[:4_000]
    return result


def _safe_selected_record(
    value: dict[str, Any],
    allowed_fields: Iterable[str],
) -> dict[str, Any]:
    """Keep only fixed selected fields even if a remote server ignores `$select`.

    The allowlist is applied after parsing because a non-conforming OData
    implementation could return additional scalar columns. This prevents a
    broad or custom 1C extension field from silently becoming agent-visible.
    """

    allowed = frozenset(allowed_fields)
    return {
        key: item
        for key, item in _safe_scalar_record(value).items()
        if key in allowed
    }


def _record_uuid(value: dict[str, Any]) -> str | None:
    reference = value.get("Ref_Key")
    if not isinstance(reference, str) or not UUID_RE.fullmatch(reference):
        return None
    return str(uuid.UUID(reference))


def _normalized_boolean(value: Any) -> bool | None:
    """Return a semantic boolean only when 1C actually supplied a JSON bool.

    Coercing strings or numbers here would make fields such as ``"false"`` or
    ``1`` look authoritative even though their meaning would depend on a
    non-standard serializer. A missing/unexpected value therefore remains
    ``null`` instead of being mixed with the document signature.
    """

    return value if isinstance(value, bool) else None


def _normalized_1c_datetime(value: Any, *, field_label: str) -> str | None:
    """Normalize one fixed 1C datetime while treating its sentinel as absent.

    1C serializes an unset date as the minimum platform timestamp
    ``0001-01-01T00:00:00``. Empty and minimum timestamps mean that the
    source field is not set. A malformed non-empty value is rejected instead
    of silently becoming ``null``: otherwise an upstream schema/serializer
    regression could produce a false business statement.
    """

    if value is None:
        return None
    if not isinstance(value, str):
        raise OneCEdoError(
            "invalid_odata_response",
            f"1С вернула некорректную дату {field_label}.",
        )
    normalized = value.strip()
    if not normalized:
        return None
    try:
        parsed = dt.datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError as error:
        raise OneCEdoError(
            "invalid_odata_response",
            f"1С вернула некорректную дату {field_label}.",
        ) from error
    if parsed == dt.datetime.min.replace(tzinfo=parsed.tzinfo):
        return None
    return normalized


def _normalized_signing_date(value: Any) -> str | None:
    """Normalize the published signing date used only for document signature."""

    return _normalized_1c_datetime(value, field_label="подписания документа")


def _normalized_register_status(value: Any) -> str | None:
    """Normalize only the current status resource from the published register.

    The 1C enum is serialized as a string by standard OData. Keeping the
    normalized scalar instead of hard-coding today's enum members makes the
    runtime forward-compatible with newly published statuses, while the
    length/control-character checks prevent an upstream serializer regression
    from becoming unbounded agent-visible text.
    """

    if value is None:
        return None
    if not isinstance(value, str):
        raise OneCEdoError(
            "invalid_odata_response",
            "1С вернула некорректное состояние ЭДО.",
        )
    normalized = value.strip()
    if not normalized:
        return None
    if (
        len(normalized) > MAX_EDO_STATUS_CHARS
        or any(
            ord(character) < 32 or ord(character) == 127
            for character in normalized
        )
    ):
        raise OneCEdoError(
            "invalid_odata_response",
            "1С вернула некорректное состояние ЭДО.",
        )
    return normalized


def _status_availability(
    status: str | None,
    *,
    reason: str | None = None,
) -> dict[str, Any]:
    """Build the stable public status contract from the primary register only."""

    availability: dict[str, Any] = {
        "available": status is not None,
        "basis": DOCUMENT_STATUS_BASIS,
        "source": STATUS_REGISTER_ENTITY,
        "coverage": DOCUMENT_STATUS_COVERAGE,
        # Ilya confirmed only the dimension and status resource. Do not invent
        # a change timestamp from deprecated document-card fields.
        "statusChangedAt": None,
    }
    if status is None:
        availability["reason"] = reason or EDO_STATUS_NO_MATCH_REASON
    return availability


def _normalize_document(value: dict[str, Any]) -> dict[str, Any]:
    """Add stable document semantics while preserving safe source scalars.

    Status is attached later from the fixed information-register lookup.
    Deprecated ``Удалить...`` card fields are neither selected nor consulted.
    Document flags and ``file.ПодписанЭП`` remain independent from both the
    status and signature normalization.
    """

    result = dict(value)
    signed_at = _normalized_signing_date(result.get("ДатаПодписания"))
    result["signature"] = {
        "isSigned": signed_at is not None,
        "signedAt": signed_at,
        "basis": DOCUMENT_SIGNATURE_BASIS,
    }
    result["edoStatus"] = "unknown"
    result["statusAvailability"] = _status_availability(
        None,
        reason=EDO_STATUS_NO_MATCH_REASON,
    )
    result["isStopped"] = _normalized_boolean(result.get("Остановлен"))
    result["exchangeWithoutSignature"] = _normalized_boolean(
        result.get("ОбменБезПодписи"),
    )
    return result


def _status_reference_filter(document_ids: Iterable[str], entity: str) -> str:
    """Build a fixed bounded OR-filter for one exact document entity type.

    Every value has already passed strict UUID normalization and ``entity`` is
    selected from ``DOCUMENT_ENTITIES``. The caller cannot contribute OData
    field names, operators, type names or parentheses.
    """

    if entity not in DOCUMENT_ENTITIES.values():
        raise OneCEdoError(
            "query_builder_error",
            "Внутренний status query получил неизвестный тип документа.",
        )
    normalized_ids = tuple(document_ids)
    if not normalized_ids or len(normalized_ids) > STATUS_LOOKUP_BATCH_SIZE:
        raise OneCEdoError(
            "query_builder_error",
            "Внутренний status query превысил фиксированный batch.",
        )
    return " or ".join(
        (
            "ЭлектронныйДокумент eq "
            f"cast(guid'{_uuid(document_id, 'document id')}', '{entity}')"
        )
        for document_id in normalized_ids
    )


def _register_row_document_key(
    row: dict[str, Any],
    *,
    direction: str,
) -> tuple[str, str]:
    """Validate the composite register dimension and return its safe key.

    Standard 1C OData serializes a composite reference as a UUID string plus
    ``<field>_Type``. Depending on serializer version, the type can be bare or
    qualified with the fixed ``StandardODATA.`` namespace; no other type is
    accepted, so an incoming and outgoing document with the same UUID cannot
    be confused.
    """

    raw_reference = row.get("ЭлектронныйДокумент")
    if not isinstance(raw_reference, str) or not UUID_RE.fullmatch(raw_reference):
        raise OneCEdoError(
            "invalid_odata_response",
            "1С вернула некорректную ссылку регистра состояний ЭДО.",
        )
    raw_type = row.get("ЭлектронныйДокумент_Type")
    expected_type = DOCUMENT_ENTITIES[direction]
    if raw_type not in {expected_type, f"StandardODATA.{expected_type}"}:
        raise OneCEdoError(
            "invalid_odata_response",
            "1С вернула некорректный тип ссылки регистра состояний ЭДО.",
        )
    return direction, str(uuid.UUID(raw_reference))


def _attach_register_statuses(
    config: CompanyConfig,
    credentials: Credentials,
    documents: dict[tuple[str, str], dict[str, Any]],
) -> None:
    """Attach authoritative status rows with bounded fixed register queries.

    Queries are grouped by direction and split into small immutable batches.
    Even if a non-compliant server ignores ``$top`` or ``$filter``, every row
    is checked against the requested UUID/type set before it can affect output.
    An unrelated row or duplicate key fails closed instead of leaking data or
    assigning a status to the wrong document.
    """

    if len(documents) > MAX_STATUS_LOOKUP_DOCUMENTS:
        raise OneCEdoError(
            "query_builder_error",
            "Внутренний status lookup превысил фиксированный лимит.",
        )
    for direction, entity in DOCUMENT_ENTITIES.items():
        direction_ids = sorted(
            document_id
            for candidate_direction, document_id in documents
            if candidate_direction == direction
        )
        for start in range(0, len(direction_ids), STATUS_LOOKUP_BATCH_SIZE):
            batch = direction_ids[start : start + STATUS_LOOKUP_BATCH_SIZE]
            expected = {(direction, document_id) for document_id in batch}
            payload = _request_odata(
                config,
                credentials,
                STATUS_REGISTER_ENTITY,
                (
                    ("$select", _selected_fields(STATUS_REGISTER_SELECT_FIELDS)),
                    ("$filter", _status_reference_filter(batch, entity)),
                    ("$top", len(batch)),
                ),
                diagnostic_stage=f"status.{direction}.lookup",
            )
            seen: set[tuple[str, str]] = set()
            for raw_row in _odata_rows(payload):
                safe_row = _safe_selected_record(
                    raw_row,
                    STATUS_REGISTER_SELECT_FIELDS,
                )
                key = _register_row_document_key(safe_row, direction=direction)
                if key not in expected:
                    raise OneCEdoError(
                        "invalid_odata_response",
                        "1С вернула постороннюю строку регистра состояний ЭДО.",
                    )
                if key in seen:
                    raise OneCEdoError(
                        "invalid_odata_response",
                        "1С вернула дублирующую строку регистра состояний ЭДО.",
                    )
                seen.add(key)
                status = _normalized_register_status(safe_row.get("Состояние"))
                document = documents[key]["document"]
                document["edoStatus"] = status or "unknown"
                document["statusAvailability"] = _status_availability(
                    status,
                    reason=EDO_STATUS_EMPTY_REASON,
                )


def _search_term(value: Any) -> str:
    """Validate user text before it can enter a fixed OData string literal."""

    term = str(value or "").strip()
    if len(term) > MAX_SEARCH_QUERY_CHARS:
        raise OneCEdoError(
            "query_too_long",
            f"Поисковый запрос длиннее {MAX_SEARCH_QUERY_CHARS} символов.",
        )
    if any(ord(character) < 32 or ord(character) == 127 for character in term):
        raise OneCEdoError(
            "query_blocked",
            "Поисковый запрос содержит управляющие символы.",
        )
    return term


def _odata_string_literal(value: str) -> str:
    """Escape an already bounded value as one indivisible OData literal.

    Doubling apostrophes is the OData string-literal rule. The caller never
    contributes operators, field names or parentheses: those remain fixed
    constants below, and `_odata_query` percent-encodes spaces as `%20`.
    """

    return f"'{value.replace(chr(39), chr(39) * 2)}'"


def _substring_filter(term: str, fields: Iterable[str]) -> str:
    literal = _odata_string_literal(term)
    return " or ".join(f"substringof({literal},{field})" for field in fields)


def _selected_fields(fields: Iterable[str]) -> str:
    return ",".join(fields)


def _bounded_odata_rows(
    config: CompanyConfig,
    credentials: Credentials,
    entity: str,
    *,
    parameters: Iterable[tuple[str, str | int]],
    limit: int,
    diagnostic_stage: str,
) -> list[dict[str, Any]]:
    """Page a fixed query without trusting the server to honor `$top`.

    `parameters` comes only from the private fixed-query builders in this
    module. Page size and count are bounded by company policy, while `limit`
    adds a smaller purpose-specific cap for fan-out searches.
    """

    bounded_limit = max(0, min(limit, config.max_rows * config.max_pages))
    if bounded_limit == 0:
        return []
    fixed_parameters = tuple(parameters)
    if any(key in {"$top", "$skip"} for key, _ in fixed_parameters):
        raise OneCEdoError(
            "query_builder_error",
            "Внутренний fixed query не может переопределять pagination.",
        )

    result: list[dict[str, Any]] = []
    for page in range(config.max_pages):
        remaining = bounded_limit - len(result)
        if remaining <= 0:
            break
        page_size = min(config.max_rows, remaining)
        payload = _request_odata(
            config,
            credentials,
            entity,
            (
                *fixed_parameters,
                ("$top", page_size),
                ("$skip", page * config.max_rows),
            ),
            diagnostic_stage=diagnostic_stage,
        )
        remote_rows = _odata_rows(payload)
        # A server that ignores `$top` cannot bypass local row/fan-out limits.
        result.extend(remote_rows[:page_size])
        if len(remote_rows) < page_size:
            break
    return result


def _mark_auth_failure(identity: Identity, config: CompanyConfig) -> None:
    # 401/403 means "credentials/access must be checked", never "the employee
    # explicitly has no account". Only `access-status set no-access` can write
    # no_access.
    save_access_state(identity, config, "needs_reconnect")


def _connected_context() -> tuple[Identity, CompanyConfig, Credentials]:
    identity = load_identity()
    config = load_company_config()
    state = load_access_state(identity, config)
    if state["status"] == "no_access":
        raise OneCEdoError(
            "no_access",
            "Пользователь явно указал отсутствие личного доступа. Обратитесь к администратору компании.",
        )
    credentials = load_credentials(identity, config)
    return identity, config, credentials


def command_connect(_: argparse.Namespace) -> dict[str, Any]:
    identity = load_identity()
    config = load_company_config()
    credentials = prompt_credentials()
    try:
        _request_odata(
            config,
            credentials,
            next(iter(DOCUMENT_ENTITIES.values())),
            (("$top", 1),),
            diagnostic_stage="connect.probe",
        )
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    # Network failures intentionally preserve the previous state and do not
    # destroy working credentials or invent either no_access/needs_reconnect.
    save_credentials(identity, config, credentials)
    save_access_state(identity, config, "connected")
    return {"status": "connected"}


def command_doctor(_: argparse.Namespace) -> dict[str, Any]:
    identity = load_identity()
    config = load_company_config()
    state = load_access_state(identity, config)
    result: dict[str, Any] = {
        "status": state["status"],
        "connectionChanged": state["connectionChanged"],
        "companyConfig": {
            "configured": True,
            "maxRows": config.max_rows,
            "maxPages": config.max_pages,
            "maxFileBytes": config.max_file_bytes,
            "requestTimeoutSeconds": config.request_timeout_seconds,
        },
        "network": "not_checked",
    }
    if state["status"] in {"connected", "needs_reconnect"}:
        try:
            credentials = load_credentials(identity, config)
            _request_odata(
                config,
                credentials,
                next(iter(DOCUMENT_ENTITIES.values())),
                (("$top", 1),),
                diagnostic_stage="doctor.probe",
            )
            save_access_state(identity, config, "connected")
            result["status"] = "connected"
            result["network"] = "ok"
        except AuthenticationError:
            _mark_auth_failure(identity, config)
            result["status"] = "needs_reconnect"
            result["network"] = "authentication_failed"
        except NetworkError:
            result["network"] = "unreachable"
    return result


def _access_help(config: CompanyConfig) -> dict[str, Any] | None:
    if not config.access_help_url and not config.access_instructions:
        return None
    return {
        "url": config.access_help_url,
        "instructions": config.access_instructions,
    }


def command_access_show(_: argparse.Namespace) -> dict[str, Any]:
    identity = load_identity()
    config = load_company_config()
    state = load_access_state(identity, config)
    return {
        "status": state["status"],
        "connectionChanged": state["connectionChanged"],
        "accessHelp": _access_help(config),
    }


def command_access_no_access(args: argparse.Namespace) -> dict[str, Any]:
    if not args.confirmed:
        raise OneCEdoError(
            "explicit_confirmation_required",
            "no_access можно поставить только после явного выбора пользователя (--confirmed).",
        )
    identity = load_identity()
    config = load_company_config()
    save_access_state(identity, config, "no_access")
    return {"status": "no_access", "accessHelp": _access_help(config)}


def command_access_reset(_: argparse.Namespace) -> dict[str, Any]:
    identity = load_identity()
    config = load_company_config()
    save_access_state(identity, config, "unknown")
    return {"status": "unknown"}


def _document_directions(direction: str) -> list[str]:
    if direction == "both":
        return ["incoming", "outgoing"]
    if direction not in DOCUMENT_ENTITIES:
        raise OneCEdoError("direction_blocked", "Разрешены incoming, outgoing или both.")
    return [direction]


def _search_business_objects(
    config: CompanyConfig,
    credentials: Credentials,
    term: str,
) -> list[dict[str, Any]]:
    """Find bounded business-object candidates through fixed description filters."""

    result: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for entity, spec in BUSINESS_ENTITY_SPECS.items():
        remaining = MAX_RELATED_BUSINESS_OBJECTS - len(result)
        if remaining <= 0:
            break
        rows = _bounded_odata_rows(
            config,
            credentials,
            entity,
            parameters=(
                ("$select", _selected_fields(BUSINESS_SELECT_FIELDS)),
                ("$filter", _substring_filter(term, ("Description",))),
            ),
            limit=min(MAX_BUSINESS_MATCHES_PER_ENTITY, remaining),
            diagnostic_stage=spec["diagnosticStage"],
        )
        for raw_row in rows:
            safe_row = _safe_selected_record(raw_row, BUSINESS_SELECT_FIELDS)
            reference = _record_uuid(safe_row)
            if reference is None:
                continue
            dedupe_key = (spec["kind"], reference)
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            result.append(
                {
                    "kind": spec["kind"],
                    "object": safe_row,
                    # Kept only inside the runtime. The caller sees the
                    # normalized kind/object, not an OData field it could
                    # attempt to feed back into a later request.
                    "_contractRelationField": spec["contractRelationField"],
                    "_reference": reference,
                },
            )
    return result


def _add_contract(
    contracts: dict[str, dict[str, Any]],
    raw_row: dict[str, Any],
    match: dict[str, str],
) -> None:
    safe_row = _safe_selected_record(raw_row, CONTRACT_SELECT_FIELDS)
    reference = _record_uuid(safe_row)
    if reference is None:
        return
    entry = contracts.setdefault(
        reference,
        {"contract": safe_row, "matchedBy": []},
    )
    if match not in entry["matchedBy"]:
        entry["matchedBy"].append(match)


def _search_contracts(
    config: CompanyConfig,
    credentials: Credentials,
    term: str,
    business_objects: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Resolve fixed business-object relations and direct contract text matches."""

    contracts: dict[str, dict[str, Any]] = {}
    related_by_field: dict[str, list[dict[str, str]]] = {}
    for item in business_objects:
        relation_field = item["_contractRelationField"]
        if not isinstance(relation_field, str):
            continue
        related_by_field.setdefault(relation_field, []).append(
            {
                "id": item["_reference"],
                "kind": item["kind"],
            },
        )

    # Only the two proven *_Key relations from the fixed schema can reach this
    # builder. UUID normalization makes every generated clause indivisible.
    for relation_field, objects in related_by_field.items():
        remaining = MAX_RELATED_CONTRACTS - len(contracts)
        if remaining <= 0:
            break
        relation_filter = " or ".join(
            f"{relation_field} eq guid'{item['id']}'"
            for item in objects
        )
        rows = _bounded_odata_rows(
            config,
            credentials,
            CONTRACT_ENTITY,
            parameters=(
                ("$select", _selected_fields(CONTRACT_SELECT_FIELDS)),
                ("$filter", relation_filter),
                # Catalogs do not expose the document system field `Date`.
                # This exact query caused the v1.0.2 production HTTP 400.
                # `Дата` is the published contract field confirmed by the
                # live metadata/result card and keeps pagination deterministic.
                ("$orderby", "Дата desc"),
            ),
            limit=remaining,
            diagnostic_stage=CONTRACT_RELATION_DIAGNOSTIC_STAGES[relation_field],
        )
        for raw_row in rows:
            raw_relation = raw_row.get(relation_field)
            normalized_relation = (
                str(uuid.UUID(raw_relation))
                if isinstance(raw_relation, str) and UUID_RE.fullmatch(raw_relation)
                else None
            )
            related = next(
                (
                    item
                    for item in objects
                    if normalized_relation == item["id"]
                ),
                objects[0],
            )
            _add_contract(
                contracts,
                raw_row,
                {
                    "kind": related["kind"],
                    "businessObjectId": related["id"],
                },
            )
            if len(contracts) >= MAX_RELATED_CONTRACTS:
                break

    remaining = MAX_RELATED_CONTRACTS - len(contracts)
    if remaining > 0:
        direct_rows = _bounded_odata_rows(
            config,
            credentials,
            CONTRACT_ENTITY,
            parameters=(
                ("$select", _selected_fields(CONTRACT_SELECT_FIELDS)),
                ("$filter", _substring_filter(term, CONTRACT_TERM_FIELDS)),
                ("$orderby", "Дата desc"),
            ),
            limit=remaining,
            diagnostic_stage="search.contracts.text",
        )
        for raw_row in direct_rows:
            _add_contract(contracts, raw_row, {"kind": "contract_text"})
    return contracts


def _add_document(
    documents: dict[tuple[str, str], dict[str, Any]],
    *,
    direction: str,
    raw_row: dict[str, Any],
    match: dict[str, str],
) -> None:
    safe_row = _normalize_document(
        _safe_selected_record(raw_row, DOCUMENT_SELECT_FIELDS),
    )
    reference = _record_uuid(safe_row)
    if reference is None:
        return
    key = (direction, reference)
    entry = documents.setdefault(
        key,
        {
            "direction": direction,
            "document": safe_row,
            "matchedBy": [],
        },
    )
    if match not in entry["matchedBy"]:
        entry["matchedBy"].append(match)


def _search_documents_for_contracts(
    config: CompanyConfig,
    credentials: Credentials,
    directions: list[str],
    contracts: dict[str, dict[str, Any]],
    documents: dict[tuple[str, str], dict[str, Any]],
    document_limit: int,
) -> None:
    """Follow only the confirmed `ДоговорКонтрагента` relation."""

    for contract_id in contracts:
        for direction in directions:
            remaining = document_limit - len(documents)
            if remaining <= 0:
                return
            contract_filter = (
                "ДоговорКонтрагента eq "
                f"cast(guid'{contract_id}', '{CONTRACT_ENTITY}')"
            )
            rows = _bounded_odata_rows(
                config,
                credentials,
                DOCUMENT_ENTITIES[direction],
                parameters=(
                    ("$select", _selected_fields(DOCUMENT_SELECT_FIELDS)),
                    ("$filter", contract_filter),
                    ("$orderby", "Date desc"),
                ),
                limit=min(MAX_DOCUMENTS_PER_CONTRACT_DIRECTION, remaining),
                diagnostic_stage=f"search.documents.{direction}.by-contract",
            )
            for raw_row in rows:
                _add_document(
                    documents,
                    direction=direction,
                    raw_row=raw_row,
                    match={"kind": "contract", "contractId": contract_id},
                )


def _search_direct_documents(
    config: CompanyConfig,
    credentials: Credentials,
    directions: list[str],
    term: str,
    documents: dict[tuple[str, str], dict[str, Any]],
    document_limit: int,
) -> None:
    """Preserve useful direct card search without scanning recent pages."""

    for direction in directions:
        remaining = document_limit - len(documents)
        if remaining <= 0:
            return
        rows = _bounded_odata_rows(
            config,
            credentials,
            DOCUMENT_ENTITIES[direction],
            parameters=(
                ("$select", _selected_fields(DOCUMENT_SELECT_FIELDS)),
                ("$filter", _substring_filter(term, DOCUMENT_TERM_FIELDS)),
                ("$orderby", "Date desc"),
            ),
            limit=remaining,
            diagnostic_stage=f"search.documents.{direction}.text",
        )
        for raw_row in rows:
            _add_document(
                documents,
                direction=direction,
                raw_row=raw_row,
                match={"kind": "document_text"},
            )


def _browse_documents(
    config: CompanyConfig,
    credentials: Credentials,
    directions: list[str],
    document_limit: int,
) -> dict[tuple[str, str], dict[str, Any]]:
    """Return a bounded recent list when the user did not supply a term."""

    documents: dict[tuple[str, str], dict[str, Any]] = {}
    for direction in directions:
        remaining = document_limit - len(documents)
        if remaining <= 0:
            break
        rows = _bounded_odata_rows(
            config,
            credentials,
            DOCUMENT_ENTITIES[direction],
            parameters=(
                ("$select", _selected_fields(DOCUMENT_SELECT_FIELDS)),
                ("$orderby", "Date desc"),
            ),
            limit=remaining,
            diagnostic_stage=f"search.documents.{direction}.recent",
        )
        for raw_row in rows:
            _add_document(
                documents,
                direction=direction,
                raw_row=raw_row,
                match={"kind": "recent"},
            )
    return documents


def command_search_documents(args: argparse.Namespace) -> dict[str, Any]:
    identity, config, credentials = _connected_context()
    term = _search_term(args.query)
    directions = _document_directions(args.direction)
    document_limit = min(
        MAX_SEARCH_DOCUMENTS,
        config.max_rows * config.max_pages * len(directions),
    )
    business_objects: list[dict[str, Any]] = []
    contracts: dict[str, dict[str, Any]] = {}
    try:
        if term:
            business_objects = _search_business_objects(config, credentials, term)
            contracts = _search_contracts(
                config,
                credentials,
                term,
                business_objects,
            )
            documents: dict[tuple[str, str], dict[str, Any]] = {}
            _search_documents_for_contracts(
                config,
                credentials,
                directions,
                contracts,
                documents,
                document_limit,
            )
            _search_direct_documents(
                config,
                credentials,
                directions,
                term,
                documents,
                document_limit,
            )
        else:
            documents = _browse_documents(
                config,
                credentials,
                directions,
                document_limit,
            )
        _attach_register_statuses(config, credentials, documents)
        save_access_state(identity, config, "connected")
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise

    public_business_objects = [
        {"kind": item["kind"], "object": item["object"]}
        for item in business_objects
    ]
    return {
        "documents": list(documents.values()),
        "count": len(documents),
        "contracts": list(contracts.values()),
        "businessObjects": public_business_objects,
        "limits": {
            "maxRows": config.max_rows,
            "maxPages": config.max_pages,
            "maxBusinessObjects": MAX_RELATED_BUSINESS_OBJECTS,
            "maxContracts": MAX_RELATED_CONTRACTS,
            "maxDocuments": document_limit,
            "maxDocumentsPerContractDirection": (
                MAX_DOCUMENTS_PER_CONTRACT_DIRECTION
            ),
        },
    }


def command_get_document(args: argparse.Namespace) -> dict[str, Any]:
    identity, config, credentials = _connected_context()
    direction = _document_directions(args.direction)
    if len(direction) != 1:
        raise OneCEdoError("direction_blocked", "get-document требует incoming или outgoing.")
    document_id = _uuid(args.document_id, "document id")
    entity = DOCUMENT_ENTITIES[direction[0]]
    filter_value = f"Ref_Key eq guid'{document_id}'"
    try:
        rows = _odata_rows(
            _request_odata(
                config,
                credentials,
                entity,
                (
                    ("$select", _selected_fields(DOCUMENT_SELECT_FIELDS)),
                    ("$filter", filter_value),
                    ("$top", 1),
                ),
                diagnostic_stage=f"document.{direction[0]}.get",
            ),
        )
        document = (
            _normalize_document(
                _safe_selected_record(rows[0], DOCUMENT_SELECT_FIELDS),
            )
            if rows
            else None
        )
        if document is not None:
            reference = _record_uuid(document)
            if reference is None:
                raise OneCEdoError(
                    "invalid_odata_response",
                    "1С вернула документ без корректного идентификатора.",
                )
            status_target = {
                (direction[0], reference): {
                    "direction": direction[0],
                    "document": document,
                    "matchedBy": [],
                },
            }
            _attach_register_statuses(config, credentials, status_target)
        save_access_state(identity, config, "connected")
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    return {
        "direction": direction[0],
        "document": document,
    }


def _new_files(
    config: CompanyConfig,
    credentials: Credentials,
    document_id: str,
    document_entity: str,
) -> list[dict[str, Any]]:
    direction = next(
        (
            candidate
            for candidate, candidate_entity in DOCUMENT_ENTITIES.items()
            if candidate_entity == document_entity
        ),
        None,
    )
    if direction is None:
        raise OneCEdoError(
            "query_builder_error",
            "Внутренний file query получил неизвестный тип документа.",
        )
    owner_filter = (
        f"ВладелецФайла eq cast(guid'{document_id}', '{document_entity}')"
    )
    rows = _odata_rows(
        _request_odata(
            config,
            credentials,
            NEW_FILE_ENTITY,
            (("$filter", owner_filter), ("$top", config.max_rows)),
            diagnostic_stage=f"files.{direction}.new",
        ),
    )
    return [{"scheme": "new", "file": _safe_scalar_record(row)} for row in rows]


def _old_files(
    config: CompanyConfig,
    credentials: Credentials,
    document_id: str,
    document_entity: str,
) -> list[dict[str, Any]]:
    direction = next(
        (
            candidate
            for candidate, candidate_entity in DOCUMENT_ENTITIES.items()
            if candidate_entity == document_entity
        ),
        None,
    )
    if direction is None:
        raise OneCEdoError(
            "query_builder_error",
            "Внутренний legacy file query получил неизвестный тип документа.",
        )
    document_filter = (
        f"ЭлектронныйДокумент eq cast(guid'{document_id}', '{document_entity}')"
    )
    message_rows = _odata_rows(
        _request_odata(
            config,
            credentials,
            OLD_MESSAGE_ENTITY,
            (("$filter", document_filter), ("$top", config.max_rows)),
            diagnostic_stage=f"files.{direction}.old-messages",
        ),
    )
    result: list[dict[str, Any]] = []
    for message in message_rows:
        if len(result) >= config.max_rows * config.max_pages:
            break
        message_id = message.get("Ref_Key")
        if not isinstance(message_id, str) or not UUID_RE.fullmatch(message_id):
            continue
        file_filter = f"ВладелецФайла_Key eq guid'{str(uuid.UUID(message_id))}'"
        file_rows = _odata_rows(
            _request_odata(
                config,
                credentials,
                OLD_FILE_ENTITY,
                (("$filter", file_filter), ("$top", config.max_rows)),
                diagnostic_stage=f"files.{direction}.old-files",
            ),
        )
        result.extend(
            {
                "scheme": "old",
                "messageId": str(uuid.UUID(message_id)),
                "file": _safe_scalar_record(row),
            }
            for row in file_rows
        )
        result = result[: config.max_rows * config.max_pages]
    return result


def command_list_files(args: argparse.Namespace) -> dict[str, Any]:
    identity, config, credentials = _connected_context()
    direction = _document_directions(args.direction)
    if len(direction) != 1:
        raise OneCEdoError("direction_blocked", "list-files требует incoming или outgoing.")
    document_id = _uuid(args.document_id, "document id")
    document_entity = DOCUMENT_ENTITIES[direction[0]]
    try:
        files = [
            *_new_files(config, credentials, document_id, document_entity),
            *_old_files(config, credentials, document_id, document_entity),
        ]
        save_access_state(identity, config, "connected")
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    return {
        "direction": direction[0],
        "documentId": document_id,
        "files": files,
        "count": len(files),
    }


def command_download_file(args: argparse.Namespace) -> dict[str, Any]:
    identity, config, credentials = _connected_context()
    url = _file_url(config, args.scheme, args.file_id)
    destination = Path(args.output).expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        suffix=".part",
        dir=destination.parent,
    )
    temporary = Path(temporary_name)
    digest = hashlib.sha256()
    total = 0
    try:
        response = _http_open(
            "GET",
            url,
            credentials=credentials,
            timeout=config.request_timeout_seconds,
            x_odata=None,
            diagnostic_stage=f"file.{args.scheme}.download",
        )
        with response, os.fdopen(descriptor, "wb") as output:
            content_length = response.headers.get("Content-Length")
            if content_length:
                try:
                    declared_size = int(content_length)
                except ValueError as error:
                    raise OneCEdoError(
                        "invalid_file_response",
                        "Файловый endpoint вернул некорректный Content-Length.",
                    ) from error
                if declared_size < 0 or declared_size > config.max_file_bytes:
                    raise OneCEdoError("file_too_large", "Файл превышает company limit.")
            while True:
                chunk = response.read(min(1024 * 1024, config.max_file_bytes - total + 1))
                if not chunk:
                    break
                total += len(chunk)
                if total > config.max_file_bytes:
                    raise OneCEdoError("file_too_large", "Файл превышает company limit.")
                output.write(chunk)
                digest.update(chunk)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
        save_access_state(identity, config, "connected")
    except AuthenticationError:
        with contextlib.suppress(OSError):
            os.close(descriptor)
        _mark_auth_failure(identity, config)
        raise
    finally:
        with contextlib.suppress(OSError):
            os.close(descriptor)
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()
    return {
        "path": str(destination),
        "sizeBytes": total,
        "sha256": digest.hexdigest(),
        "scheme": args.scheme,
        "fileId": _uuid(args.file_id, "file id"),
    }


def command_forget_credentials(_: argparse.Namespace) -> dict[str, Any]:
    identity = load_identity()
    config = load_company_config()
    removed = _delete_private_file(credentials_path(identity))
    _delete_private_file(general_schema_cache_path(identity))
    save_access_state(identity, config, "unknown")
    return {"status": "unknown", "credentialsRemoved": removed}


def _general_registry_material(section: str, kind: str) -> dict[str, Any]:
    """Return the private canonical material used for one capability digest.

    The digest is agent-visible, but this material is not.  In particular,
    ordinary production results never expose internal 1C field names.
    """

    source = (
        GENERAL_REFERENCE_SPECS if section == "reference"
        else GENERAL_DOCUMENT_SPECS
    )
    specs = source.get(kind)
    if specs is None:
        raise OneCEdoError(
            "capability_blocked",
            "Запрошенная capability не входит в фиксированный registry.",
        )
    return {
        "registryVersion": 1,
        "section": section,
        "kind": kind,
        "sources": [
            {
                "entity": spec["entity"],
                "sourceType": spec["sourceType"],
                "fields": dict(sorted(spec["fields"].items())),
                "lineFields": dict(sorted(spec.get("lineFields", {}).items())),
                "filters": list(spec.get("filters", ())),
            }
            for spec in specs
        ],
    }


def _general_capability_digest(section: str, kind: str) -> str:
    raw = json.dumps(
        _general_registry_material(section, kind),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


def _general_registry_digest() -> str:
    """Bind cache entries to the complete signed broad capability registry."""

    material = [
        _general_registry_material(section, kind)
        for section, registry in (
            ("reference", GENERAL_REFERENCE_SPECS),
            ("document", GENERAL_DOCUMENT_SPECS),
        )
        for kind in registry
    ]
    raw = _canonical_json(material).encode("utf-8")
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


def _general_identity_boundary(identity: Identity) -> str:
    """Hash the identity tuple so the cache payload does not repeat UUIDs."""

    raw = _canonical_json(
        {
            "companyId": identity.company_id,
            "memberId": identity.member_id,
            "connectionId": identity.connection_id,
        },
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


def _general_cache_hmac_key(
    identity: Identity,
    credentials: Credentials,
) -> bytes:
    """Derive a local integrity key without persisting another secret.

    Anyone who can read the personal credential file already controls the 1C
    session.  HMAC still protects against a lower-privileged process that can
    tamper with the cache path but cannot read that private credential file.
    """

    # Canonical JSON keeps the derivation unambiguous even if a credential
    # contains a delimiter-like character.
    material = _canonical_json(
        {
            "context": "trelio-1c-general-schema-cache-v1",
            "companyId": identity.company_id,
            "memberId": identity.member_id,
            "connectionId": identity.connection_id,
            "username": credentials.username,
            "password": credentials.password,
        },
    ).encode("utf-8")
    return hashlib.sha256(material).digest()


def _sign_general_schema_cache(
    payload: Mapping[str, Any],
    identity: Identity,
    credentials: Credentials,
) -> str:
    return hmac.new(
        _general_cache_hmac_key(identity, credentials),
        _canonical_json(payload).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _general_capability_keys() -> tuple[str, ...]:
    return (
        *(f"reference.{kind}" for kind in GENERAL_REFERENCE_SPECS),
        *(f"document.{kind}" for kind in GENERAL_DOCUMENT_SPECS),
    )


def _general_schema_capability_states(
    entity_sets: Mapping[str, str],
    type_fields: Mapping[str, Mapping[str, str]],
) -> dict[str, str]:
    """Reduce full metadata to exact allowlisted verification verdicts."""

    states: dict[str, str] = {}
    for section, registry in (
        ("reference", GENERAL_REFERENCE_SPECS),
        ("document", GENERAL_DOCUMENT_SPECS),
    ):
        for kind in registry:
            state = "matched"
            material = _general_registry_material(section, kind)
            for source in material["sources"]:
                entity_type = entity_sets.get(source["entity"])
                fields = type_fields.get(entity_type or "", {})
                if not entity_type:
                    state = "entity_missing"
                    break
                if any(
                    fields.get(field) != expected_type
                    for field, expected_type in source["fields"].items()
                ):
                    state = "field_mapping_changed"
                    break
                line_fields = source["lineFields"]
                if not line_fields:
                    continue
                collection_type = fields.get("Товары", "")
                if not (
                    collection_type.startswith("Collection(")
                    and collection_type.endswith(")")
                ):
                    state = "line_collection_changed"
                    break
                row_fields = type_fields.get(collection_type[11:-1], {})
                if any(
                    row_fields.get(field) != expected_type
                    for field, expected_type in line_fields.items()
                ):
                    state = "line_mapping_changed"
                    break
            states[f"{section}.{kind}"] = state
    return states


def _metadata_validator_kind(
    etag: str | None,
    last_modified: str | None,
) -> str:
    if etag and last_modified:
        return "etag_and_last_modified"
    if etag:
        return "etag"
    if last_modified:
        return "last_modified"
    return "none"


def _read_general_schema_cache(
    identity: Identity,
    config: CompanyConfig,
    credentials: Credentials,
) -> dict[str, Any] | None:
    path = general_schema_cache_path(identity)
    _assert_not_symlink(path)
    if not path.exists():
        return None
    try:
        if path.stat().st_size > MAX_GENERAL_SCHEMA_CACHE_BYTES:
            raise OneCEdoError(
                "invalid_local_state",
                "Локальный metadata cache превысил безопасный размер.",
            )
    except OSError as error:
        raise OneCEdoError(
            "invalid_local_state",
            "Не удалось проверить локальный metadata cache.",
        ) from error
    stored = _read_private_json(path)
    if stored is None:
        return None
    integrity = stored.pop("integrity", None)
    if (
        not isinstance(integrity, str)
        or len(integrity) != 64
        or not hmac.compare_digest(
            integrity,
            _sign_general_schema_cache(stored, identity, credentials),
        )
    ):
        raise OneCEdoError(
            "invalid_local_state",
            "Целостность локального metadata cache не подтверждена.",
        )

    # A valid old cache is a miss, never an authorization shortcut, after any
    # release, registry, connection or identity-boundary change.
    if (
        stored.get("schemaVersion") != GENERAL_SCHEMA_CACHE_VERSION
        or stored.get("runtimeVersion") != RUNTIME_VERSION
        or stored.get("registryDigest") != _general_registry_digest()
        or stored.get("connectionFingerprint") != config.fingerprint
        or stored.get("identityBoundary") != _general_identity_boundary(identity)
    ):
        return None

    schema_digest = stored.get("schemaDigest")
    states = stored.get("capabilityStates")
    validators = stored.get("validators")
    if (
        not isinstance(schema_digest, str)
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", schema_digest)
        or not isinstance(states, dict)
        or set(states) != set(_general_capability_keys())
        or any(
            value
            not in {
                "matched",
                "entity_missing",
                "field_mapping_changed",
                "line_collection_changed",
                "line_mapping_changed",
            }
            for value in states.values()
        )
        or not isinstance(validators, dict)
    ):
        raise OneCEdoError(
            "invalid_local_state",
            "Локальный metadata cache имеет некорректную структуру.",
        )
    etag = validators.get("etag")
    last_modified = validators.get("lastModified")
    if etag is not None and (
        not isinstance(etag, str)
        or len(etag) > MAX_METADATA_ETAG_CHARS
        or not METADATA_ETAG_RE.fullmatch(etag)
    ):
        raise OneCEdoError(
            "invalid_local_state",
            "Локальный ETag metadata cache повреждён.",
        )
    if last_modified is not None:
        if (
            not isinstance(last_modified, str)
            or len(last_modified) > MAX_METADATA_LAST_MODIFIED_CHARS
            or "\r" in last_modified
            or "\n" in last_modified
        ):
            raise OneCEdoError(
                "invalid_local_state",
                "Локальный Last-Modified metadata cache повреждён.",
            )
        try:
            if email.utils.parsedate_to_datetime(last_modified) is None:
                raise ValueError("invalid Last-Modified")
        except (TypeError, ValueError, OverflowError) as error:
            raise OneCEdoError(
                "invalid_local_state",
                "Локальный Last-Modified metadata cache повреждён.",
            ) from error
    if not etag and not last_modified:
        # Entries without a server validator can never satisfy the
        # per-request validation contract.
        return None
    return stored


def _write_general_schema_cache(
    identity: Identity,
    config: CompanyConfig,
    credentials: Credentials,
    *,
    schema_digest: str,
    states: Mapping[str, str],
    etag: str | None,
    last_modified: str | None,
) -> None:
    if not etag and not last_modified:
        _delete_private_file(general_schema_cache_path(identity))
        return
    payload: dict[str, Any] = {
        "schemaVersion": GENERAL_SCHEMA_CACHE_VERSION,
        "runtimeVersion": RUNTIME_VERSION,
        "registryDigest": _general_registry_digest(),
        "connectionFingerprint": config.fingerprint,
        "identityBoundary": _general_identity_boundary(identity),
        "schemaDigest": schema_digest,
        "capabilityStates": dict(states),
        "validators": {
            "etag": etag,
            "lastModified": last_modified,
        },
        "verifiedAt": _utc_now(),
    }
    payload["integrity"] = _sign_general_schema_cache(
        payload,
        identity,
        credentials,
    )
    _write_private_json(general_schema_cache_path(identity), payload)


def _parse_general_schema(
    raw: bytes,
) -> tuple[dict[str, str], dict[str, dict[str, str]]]:
    """Parse only entity-set/type/property names required for verification."""

    try:
        root = ET.fromstring(raw)
    except ET.ParseError as error:
        raise OneCEdoError(
            "invalid_metadata_response",
            "1С вернула некорректный XML metadata.",
        ) from error

    entity_sets: dict[str, str] = {}
    type_fields: dict[str, dict[str, str]] = {}
    for schema in (
        element
        for element in root.iter()
        if _xml_local_name(element.tag) == "Schema"
    ):
        namespace = str(schema.attrib.get("Namespace") or "")
        for child in schema:
            local_name = _xml_local_name(child.tag)
            if local_name in {"EntityType", "ComplexType"}:
                type_name = str(child.attrib.get("Name") or "")
                if not type_name:
                    continue
                properties = {
                    str(property_item.attrib.get("Name")): str(
                        property_item.attrib.get("Type"),
                    )
                    for property_item in child
                    if (
                        _xml_local_name(property_item.tag) == "Property"
                        and property_item.attrib.get("Name")
                        and property_item.attrib.get("Type")
                    )
                }
                type_fields[type_name] = properties
                if namespace:
                    type_fields[f"{namespace}.{type_name}"] = properties
            elif local_name == "EntityContainer":
                for entity_set in child:
                    if _xml_local_name(entity_set.tag) != "EntitySet":
                        continue
                    name = str(entity_set.attrib.get("Name") or "")
                    entity_type = str(entity_set.attrib.get("EntityType") or "")
                    if name and entity_type:
                        entity_sets[name] = entity_type
    return entity_sets, type_fields


def _verify_general_schema(
    config: CompanyConfig,
    credentials: Credentials,
    capabilities: Iterable[tuple[str, str]],
) -> dict[str, Any]:
    """Validate the remote schema on every broad command.

    The first command downloads and parses full metadata. A later one may use
    the private projection only after the same fixed route confirms ETag or
    Last-Modified with HTTP 304. Network errors, missing validators, a 200
    response, cache tampering or any binding mismatch never reuse stale state.
    """

    identity = load_identity()
    with _exclusive_private_file_lock(general_schema_cache_lock_path(identity)):
        cached = _read_general_schema_cache(identity, config, credentials)
        validators = (
            dict(cached["validators"])
            if cached is not None
            else None
        )
        resource = _request_metadata_resource(
            config,
            credentials,
            validators=validators,
            diagnostic_stage="general.schema.verify",
        )
        if resource.status == 304:
            if cached is None:
                raise OneCEdoError(
                    "invalid_metadata_response",
                    "1С вернула 304 без подтверждённого локального metadata cache.",
                )
            cached_etag = validators.get("etag")
            cached_last_modified = validators.get("lastModified")
            if (
                resource.etag is not None
                and cached_etag is not None
                and resource.etag != cached_etag
            ) or (
                resource.last_modified is not None
                and cached_last_modified is not None
                and resource.last_modified != cached_last_modified
            ):
                # A 304 may omit validators or add a previously absent one,
                # but it must not contradict a validator that caused this
                # conditional request. Treat such a response as ambiguous and
                # never reuse the cached projection.
                raise OneCEdoError(
                    "invalid_metadata_response",
                    "1С вернула противоречивое подтверждение metadata validator.",
                )
            schema_digest = str(cached["schemaDigest"])
            states = dict(cached["capabilityStates"])
            etag = resource.etag or cached_etag
            last_modified = (
                resource.last_modified or cached_last_modified
            )
            _write_general_schema_cache(
                identity,
                config,
                credentials,
                schema_digest=schema_digest,
                states=states,
                etag=etag,
                last_modified=last_modified,
            )
            validation = {
                "mode": "conditional_not_modified",
                "conditionalRequest": True,
                "serverValidator": _metadata_validator_kind(
                    etag,
                    last_modified,
                ),
                "cacheProjectionUsed": True,
                "metadataResponseEncoding": "not_modified",
            }
        elif resource.status == 200 and resource.body is not None:
            schema_digest = (
                f"sha256:{hashlib.sha256(resource.body).hexdigest()}"
            )
            entity_sets, type_fields = _parse_general_schema(resource.body)
            states = _general_schema_capability_states(
                entity_sets,
                type_fields,
            )
            _write_general_schema_cache(
                identity,
                config,
                credentials,
                schema_digest=schema_digest,
                states=states,
                etag=resource.etag,
                last_modified=resource.last_modified,
            )
            validation = {
                "mode": (
                    "conditional_full_response"
                    if validators
                    else "full_download"
                ),
                "conditionalRequest": bool(validators),
                "serverValidator": _metadata_validator_kind(
                    resource.etag,
                    resource.last_modified,
                ),
                "cacheProjectionUsed": False,
                "metadataResponseEncoding": resource.content_encoding,
            }
        else:
            raise OneCEdoError(
                "invalid_metadata_response",
                "1С вернула неожиданный ответ metadata.",
            )

    verified: dict[str, str] = {}
    for section, kind in capabilities:
        key = f"{section}.{kind}"
        state = states.get(key)
        if state != "matched":
            detail = {
                "entity_missing": "entity отсутствует в текущей schema",
                "field_mapping_changed": "mapping больше не совпадает со schema",
                "line_collection_changed": "строки документа больше не подтверждены",
                "line_mapping_changed": "mapping строк больше не совпадает со schema",
            }.get(str(state), "результат проверки schema неоднозначен")
            raise OneCEdoError(
                "capability_schema_changed",
                f"1С capability {key} отключена: {detail}.",
            )
        verified[key] = _general_capability_digest(section, kind)
    return {
        "schemaDigest": schema_digest,
        "inventorySchemaDigest": GENERAL_INVENTORY_SCHEMA_DIGEST,
        "fullSchemaChanged": schema_digest != GENERAL_INVENTORY_SCHEMA_DIGEST,
        "capabilityDigests": verified,
        "validation": validation,
    }


def _general_uuid_value(value: Any, field_label: str) -> str | None:
    """Normalize a 1C reference, treating its all-zero sentinel as absent."""

    if value in {None, "", "00000000-0000-0000-0000-000000000000"}:
        return None
    if not isinstance(value, str) or not UUID_RE.fullmatch(value):
        raise OneCEdoError(
            "invalid_odata_response",
            f"1С вернула некорректный {field_label}.",
        )
    return str(uuid.UUID(value))


def _general_text(value: Any) -> str | None:
    return value[:4_000] if isinstance(value, str) else None


def _general_number(value: Any) -> int | float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _general_integer(value: Any) -> int | None:
    """Normalize an EDM integer without accepting arbitrary numeric text.

    Standard OData JSON commonly serializes `Edm.Int64` as a decimal string to
    avoid JavaScript precision loss.  Only a short canonical integer form is
    accepted; floats, exponent notation and other strings remain invalid.
    """

    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if (
        isinstance(value, str)
        and len(value) <= 20
        and re.fullmatch(r"-?(?:0|[1-9][0-9]*)", value)
    ):
        return int(value)
    return None


def _general_reference_record(
    kind: str,
    spec: dict[str, Any],
    raw: dict[str, Any],
    *,
    matched_by: list[str],
) -> dict[str, Any]:
    safe = _safe_selected_record(raw, spec["fields"])
    reference = _general_uuid_value(safe.get("Ref_Key"), "reference id")
    if reference is None:
        raise OneCEdoError(
            "invalid_odata_response",
            "1С вернула справочник без идентификатора.",
        )
    source_type = str(spec["sourceType"])
    item: dict[str, Any] = {
        "id": reference,
        "kind": kind,
        "type": source_type,
        "name": _general_text(safe.get("Description")),
        "code": _general_text(safe.get("Code") or safe.get("Номер")),
        "fullName": _general_text(safe.get("НаименованиеПолное")),
        "status": _general_text(safe.get("Статус")),
        "isDeleted": _normalized_boolean(safe.get("DeletionMark")),
        "parentId": _general_uuid_value(safe.get("Parent_Key"), "parent id"),
        "organizationId": _general_uuid_value(
            safe.get("Owner_Key") or safe.get("Организация_Key"),
            "organization id",
        ),
        "counterpartyId": _general_uuid_value(
            safe.get("Контрагент_Key"),
            "counterparty id",
        ),
        "partnerId": _general_uuid_value(safe.get("Партнер_Key"), "partner id"),
        "businessUnitId": _general_uuid_value(
            safe.get("Подразделение_Key"),
            "business unit id",
        ),
        "unitId": _general_uuid_value(
            safe.get("ЕдиницаИзмерения_Key"),
            "unit id",
        ),
        "itemType": _general_text(safe.get("ТипНоменклатуры")),
        "warehouseType": _general_text(safe.get("ТипСклада")),
        "isFolder": _normalized_boolean(safe.get("IsFolder")),
        "isCustomer": _normalized_boolean(safe.get("Клиент")),
        "isSupplier": _normalized_boolean(safe.get("Поставщик")),
        "contractDate": _normalized_1c_datetime(
            safe.get("Дата"),
            field_label="contract date",
        ),
        "validFrom": _normalized_1c_datetime(
            safe.get("ДатаНачалаДействия"),
            field_label="contract valid from",
        ),
        "validTo": _normalized_1c_datetime(
            safe.get("ДатаОкончанияДействия"),
            field_label="contract valid to",
        ),
        "contractType": _general_text(safe.get("ТипДоговора")),
        "operation": _general_text(safe.get("ХозяйственнаяОперация")),
        "approved": _normalized_boolean(safe.get("Согласован")),
        "matchedBy": matched_by,
        "source": {
            "kind": "reference",
            "type": source_type,
            "id": reference,
        },
    }
    return item


def _general_search_matches(
    raw: dict[str, Any],
    spec: dict[str, Any],
    term: str,
) -> list[str]:
    if not term:
        return ["browse"]
    normalized = term.casefold()
    field_labels = {
        "Description": "name",
        "НаименованиеПолное": "full_name",
        "Code": "code",
        "Артикул": "article",
        "Номер": "number",
    }
    matches = [
        f"query.{field_labels.get(field, 'text')}"
        for field in spec["searchFields"]
        if isinstance(raw.get(field), str)
        and normalized in str(raw[field]).casefold()
    ]
    return matches or ["query"]


def _general_page(args: argparse.Namespace, config: CompanyConfig) -> tuple[int, int]:
    page = int(args.page)
    limit = int(args.limit)
    max_pages = min(config.max_pages, GENERAL_MAX_PAGES)
    max_limit = min(config.max_rows, GENERAL_MAX_PAGE_SIZE)
    if page < 1 or page > max_pages:
        raise OneCEdoError(
            "page_out_of_range",
            f"page должна быть от 1 до {max_pages}.",
        )
    if limit < 1 or limit > max_limit:
        raise OneCEdoError(
            "limit_out_of_range",
            f"limit должен быть от 1 до {max_limit}.",
        )
    return page, limit


def _general_reference_search_rows(
    config: CompanyConfig,
    credentials: Credentials,
    kind: str,
    spec: dict[str, Any],
    term: str,
    target: int,
) -> list[dict[str, Any]]:
    clauses = ["DeletionMark eq false"]
    if term:
        clauses.append(f"({_substring_filter(term, spec['searchFields'])})")
    return _bounded_odata_rows(
        config,
        credentials,
        spec["entity"],
        parameters=(
            ("$select", _selected_fields(spec["fields"])),
            ("$filter", " and ".join(clauses)),
            ("$orderby", "Description asc"),
        ),
        limit=target,
        diagnostic_stage=f"general.reference.{kind}.search",
    )


def command_general_get_capabilities(_: argparse.Namespace) -> dict[str, Any]:
    identity, config, credentials = _connected_context()
    all_capabilities = [
        *(("reference", kind) for kind in GENERAL_REFERENCE_SPECS),
        *(("document", kind) for kind in GENERAL_DOCUMENT_SPECS),
    ]
    try:
        schema = _verify_general_schema(config, credentials, all_capabilities)
        save_access_state(identity, config, "connected")
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    references = [
        {
            "kind": kind,
            "status": "supported",
            "types": [spec["sourceType"] for spec in specs],
            "filters": ["query"],
            "capabilityDigest": schema["capabilityDigests"][f"reference.{kind}"],
        }
        for kind, specs in GENERAL_REFERENCE_SPECS.items()
    ]
    documents = [
        {
            "kind": kind,
            "status": "supported",
            "types": [spec["sourceType"] for spec in specs],
            "filters": list(specs[0]["filters"]),
            "includeLines": True,
            "capabilityDigest": schema["capabilityDigests"][f"document.{kind}"],
        }
        for kind, specs in GENERAL_DOCUMENT_SPECS.items()
    ]
    return {
        "registryVersion": 1,
        "schema": schema,
        "sections": {
            "references": references,
            "documents": documents,
            "balances": [
                {
                    "kind": "stock",
                    "status": "unsupported",
                    "reason": "needs_custom_endpoint",
                },
            ],
            "links": [
                {
                    "kind": "business_unit",
                    "status": "supported",
                    "sourceTypes": ["enterprise_structure"],
                },
                {"kind": "contract", "status": "supported"},
                {"kind": "document", "status": "supported"},
            ],
        },
        "limits": {
            "maxPageSize": min(config.max_rows, GENERAL_MAX_PAGE_SIZE),
            "maxPages": min(config.max_pages, GENERAL_MAX_PAGES),
            "maxLines": GENERAL_MAX_LINES,
            "requestTimeoutSeconds": config.request_timeout_seconds,
            "responseBytes": MAX_ODATA_RESPONSE_BYTES,
            "metadataBytes": MAX_METADATA_RESPONSE_BYTES,
        },
        "readOnly": True,
    }


def command_general_search_reference_items(args: argparse.Namespace) -> dict[str, Any]:
    identity, config, credentials = _connected_context()
    kind = str(args.kind)
    specs = GENERAL_REFERENCE_SPECS[kind]
    term = _search_term(args.query)
    page, limit = _general_page(args, config)
    # One extra row lets the runtime report truncation without exposing a
    # remote count.  Multi-entity kinds are merged and sliced locally.
    target = min(
        (page * limit) + 1,
        min(config.max_rows, GENERAL_MAX_PAGE_SIZE)
        * min(config.max_pages, GENERAL_MAX_PAGES),
    )
    try:
        schema = _verify_general_schema(
            config,
            credentials,
            (("reference", kind),),
        )
        combined: list[dict[str, Any]] = []
        saturated = False
        for spec in specs:
            rows = _general_reference_search_rows(
                config,
                credentials,
                kind,
                spec,
                term,
                target,
            )
            saturated = saturated or len(rows) >= target
            combined.extend(
                _general_reference_record(
                    kind,
                    spec,
                    row,
                    matched_by=_general_search_matches(row, spec, term),
                )
                for row in rows
            )
        save_access_state(identity, config, "connected")
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    combined.sort(
        key=lambda item: (
            str(item.get("name") or "").casefold(),
            str(item["type"]),
            str(item["id"]),
        ),
    )
    start = (page - 1) * limit
    end = start + limit
    items = combined[start:end]
    return {
        "kind": kind,
        "items": items,
        "count": len(items),
        "matchedBy": "fixed_query" if term else "browse",
        "pagination": {
            "page": page,
            "limit": limit,
            "truncated": saturated or len(combined) > end,
        },
        "schema": schema,
        "limits": {
            "maxPageSize": min(config.max_rows, GENERAL_MAX_PAGE_SIZE),
            "maxPages": min(config.max_pages, GENERAL_MAX_PAGES),
        },
    }


def _general_reference_by_id(
    config: CompanyConfig,
    credentials: Credentials,
    kind: str,
    reference: str,
    *,
    specs: tuple[dict[str, Any], ...] | None = None,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for spec in specs or GENERAL_REFERENCE_SPECS[kind]:
        rows = _odata_rows(
            _request_odata(
                config,
                credentials,
                spec["entity"],
                (
                    ("$select", _selected_fields(spec["fields"])),
                    ("$filter", f"Ref_Key eq guid'{reference}'"),
                    ("$top", 2),
                ),
                diagnostic_stage=f"general.reference.{kind}.get",
            ),
        )
        for row in rows[:2]:
            normalized = _general_reference_record(
                kind,
                spec,
                row,
                matched_by=["id"],
            )
            if normalized["id"] != reference:
                raise OneCEdoError(
                    "invalid_odata_response",
                    "1С вернула посторонний справочник для exact id.",
                )
            result.append(normalized)
    return result


def command_general_get_reference_item(args: argparse.Namespace) -> dict[str, Any]:
    identity, config, credentials = _connected_context()
    kind = str(args.kind)
    reference = _uuid(args.id, "reference id")
    try:
        schema = _verify_general_schema(
            config,
            credentials,
            (("reference", kind),),
        )
        matches = _general_reference_by_id(
            config,
            credentials,
            kind,
            reference,
        )
        save_access_state(identity, config, "connected")
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    if len(matches) > 1:
        raise OneCEdoError(
            "ambiguous_reference",
            "Один UUID найден в нескольких фиксированных типах справочника.",
        )
    return {
        "kind": kind,
        "item": matches[0] if matches else None,
        "matchedBy": ["id"],
        "schema": schema,
    }


def _general_parse_date(value: str, label: str) -> dt.date | None:
    normalized = str(value or "").strip()
    if not normalized:
        return None
    try:
        return dt.date.fromisoformat(normalized)
    except ValueError as error:
        raise OneCEdoError(
            "invalid_date",
            f"{label} должна быть датой YYYY-MM-DD.",
        ) from error


def _general_document_filter(
    args: argparse.Namespace,
    spec: dict[str, Any],
) -> tuple[str, list[str]]:
    requested: dict[str, Any] = {
        "period": bool(args.date_from or args.date_to),
        "organization": args.organization_id,
        "business_unit": args.business_unit_id,
        "counterparty": args.counterparty_id,
        "contract": args.contract_id,
        "number": args.number,
        "status": args.status,
    }
    unsupported = [
        name
        for name, value in requested.items()
        if value and name not in spec["filters"]
    ]
    if unsupported:
        raise OneCEdoError(
            "filter_unsupported",
            f"Фильтр {unsupported[0]} не поддержан для этого типа документа.",
        )

    clauses: list[str] = []
    matched: list[str] = []
    date_from = _general_parse_date(args.date_from, "date-from")
    date_to = _general_parse_date(args.date_to, "date-to")
    if date_from and date_to and date_from > date_to:
        raise OneCEdoError(
            "invalid_period",
            "date-from не может быть позже date-to.",
        )
    if date_from:
        clauses.append(f"Date ge datetime'{date_from.isoformat()}T00:00:00'")
        matched.append("period")
    if date_to:
        exclusive = date_to + dt.timedelta(days=1)
        clauses.append(f"Date lt datetime'{exclusive.isoformat()}T00:00:00'")
        if "period" not in matched:
            matched.append("period")

    uuid_filters = (
        ("organization", args.organization_id, "Организация_Key"),
        ("business_unit", args.business_unit_id, "Подразделение_Key"),
        ("counterparty", args.counterparty_id, "Контрагент_Key"),
        ("contract", args.contract_id, "Договор_Key"),
    )
    for label, value, field in uuid_filters:
        if not value:
            continue
        reference = _uuid(value, f"{label} id")
        clauses.append(f"{field} eq guid'{reference}'")
        matched.append(label)
    number = _search_term(args.number)
    if number:
        clauses.append(f"substringof({_odata_string_literal(number)},Number)")
        matched.append("number")
    if args.status == "deleted":
        clauses.append("DeletionMark eq true")
        matched.append("status.deleted")
    else:
        clauses.append("DeletionMark eq false")
        if args.status == "posted":
            clauses.append("Posted eq true")
            matched.append("status.posted")
        elif args.status == "unposted":
            clauses.append("Posted eq false")
            matched.append("status.unposted")
    return " and ".join(f"({clause})" for clause in clauses), matched or ["recent"]


def _general_document_record(
    kind: str,
    spec: dict[str, Any],
    raw: dict[str, Any],
    *,
    matched_by: list[str],
    include_lines: bool,
    line_limit: int,
) -> dict[str, Any]:
    safe = _safe_selected_record(raw, spec["fields"])
    reference = _general_uuid_value(safe.get("Ref_Key"), "document id")
    if reference is None:
        raise OneCEdoError(
            "invalid_odata_response",
            "1С вернула документ без идентификатора.",
        )
    source_type = str(spec["sourceType"])
    raw_lines = raw.get("Товары") if include_lines else []
    if raw_lines is None:
        raw_lines = []
    if not isinstance(raw_lines, list):
        raise OneCEdoError(
            "invalid_odata_response",
            "1С вернула строки документа в неожиданном формате.",
        )
    normalized_lines: list[dict[str, Any]] = []
    for raw_line in raw_lines[:line_limit]:
        if not isinstance(raw_line, dict):
            continue
        line = _safe_selected_record(raw_line, spec["lineFields"])
        normalized_lines.append({
            "lineNumber": _general_integer(line.get("LineNumber")),
            "itemId": _general_uuid_value(line.get("Номенклатура_Key"), "line item id"),
            "variantId": _general_uuid_value(
                line.get("Характеристика_Key"),
                "line variant id",
            ),
            "quantity": _general_number(line.get("Количество")),
            "price": _general_number(line.get("Цена")),
            "amount": _general_number(line.get("Сумма")),
            "vatAmount": _general_number(line.get("СуммаНДС")),
            "warehouseId": _general_uuid_value(
                line.get("Склад_Key"),
                "line warehouse id",
            ),
            "businessUnitId": _general_uuid_value(
                line.get("Подразделение_Key"),
                "line business unit id",
            ),
        })
    document = {
        "id": reference,
        "kind": kind,
        "type": source_type,
        "number": _general_text(safe.get("Number")),
        "date": _normalized_1c_datetime(safe.get("Date"), field_label="document date"),
        "postingStatus": (
            "posted"
            if safe.get("Posted") is True
            else "unposted"
            if safe.get("Posted") is False
            else "unknown"
        ),
        "isDeleted": _normalized_boolean(safe.get("DeletionMark")),
        "organizationId": _general_uuid_value(
            safe.get("Организация_Key"),
            "organization id",
        ),
        "destinationOrganizationId": _general_uuid_value(
            safe.get("ОрганизацияПолучатель_Key"),
            "destination organization id",
        ),
        "businessUnitId": _general_uuid_value(
            safe.get("Подразделение_Key"),
            "business unit id",
        ),
        "counterpartyId": _general_uuid_value(
            safe.get("Контрагент_Key"),
            "counterparty id",
        ),
        "partnerId": _general_uuid_value(safe.get("Партнер_Key"), "partner id"),
        "contractId": _general_uuid_value(safe.get("Договор_Key"), "contract id"),
        "warehouseId": _general_uuid_value(
            safe.get("Склад_Key") or safe.get("СкладОтправитель_Key"),
            "warehouse id",
        ),
        "destinationWarehouseId": _general_uuid_value(
            safe.get("СкладПолучатель_Key"),
            "destination warehouse id",
        ),
        "amount": _general_number(safe.get("СуммаДокумента")),
        "comment": _general_text(safe.get("Комментарий")),
        "sourceStatus": _general_text(safe.get("Статус")),
        "matchedBy": matched_by,
        "lines": normalized_lines,
        "lineInfo": {
            "included": include_lines,
            "returned": len(normalized_lines),
            "limit": line_limit if include_lines else 0,
            "truncated": include_lines and len(raw_lines) > line_limit,
        },
        "source": {
            "kind": "document",
            "type": source_type,
            "id": reference,
        },
    }
    return document


def _general_document_select(spec: dict[str, Any], include_lines: bool) -> str:
    fields = [
        field
        for field in spec["fields"]
        if include_lines or field != "Товары"
    ]
    return _selected_fields(fields)


def command_general_search_documents(args: argparse.Namespace) -> dict[str, Any]:
    identity, config, credentials = _connected_context()
    kind = str(args.kind)
    specs = GENERAL_DOCUMENT_SPECS[kind]
    page, limit = _general_page(args, config)
    target = min(
        (page * limit) + 1,
        min(config.max_rows, GENERAL_MAX_PAGE_SIZE)
        * min(config.max_pages, GENERAL_MAX_PAGES),
    )
    try:
        schema = _verify_general_schema(
            config,
            credentials,
            (("document", kind),),
        )
        combined: list[dict[str, Any]] = []
        saturated = False
        for spec in specs:
            filter_value, matched_by = _general_document_filter(args, spec)
            rows = _bounded_odata_rows(
                config,
                credentials,
                spec["entity"],
                parameters=(
                    ("$select", _general_document_select(spec, False)),
                    ("$filter", filter_value),
                    ("$orderby", "Date desc"),
                ),
                limit=target,
                diagnostic_stage=f"general.document.{kind}.search",
            )
            saturated = saturated or len(rows) >= target
            combined.extend(
                _general_document_record(
                    kind,
                    spec,
                    row,
                    matched_by=list(matched_by),
                    include_lines=False,
                    line_limit=0,
                )
                for row in rows
            )
        save_access_state(identity, config, "connected")
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    combined.sort(
        key=lambda item: (
            str(item.get("date") or ""),
            str(item.get("number") or ""),
            str(item["id"]),
        ),
        reverse=True,
    )
    start = (page - 1) * limit
    end = start + limit
    documents = combined[start:end]
    return {
        "kind": kind,
        "documents": documents,
        "count": len(documents),
        "pagination": {
            "page": page,
            "limit": limit,
            "truncated": saturated or len(combined) > end,
        },
        "schema": schema,
        "limits": {
            "maxPageSize": min(config.max_rows, GENERAL_MAX_PAGE_SIZE),
            "maxPages": min(config.max_pages, GENERAL_MAX_PAGES),
        },
    }


def _general_documents_by_id(
    config: CompanyConfig,
    credentials: Credentials,
    kind: str,
    reference: str,
    *,
    include_lines: bool,
    line_limit: int,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for spec in GENERAL_DOCUMENT_SPECS[kind]:
        rows = _odata_rows(
            _request_odata(
                config,
                credentials,
                spec["entity"],
                (
                    ("$select", _general_document_select(spec, include_lines)),
                    ("$filter", f"Ref_Key eq guid'{reference}'"),
                    ("$top", 2),
                ),
                diagnostic_stage=f"general.document.{kind}.get",
            ),
        )
        for row in rows[:2]:
            document = _general_document_record(
                kind,
                spec,
                row,
                matched_by=["id"],
                include_lines=include_lines,
                line_limit=line_limit,
            )
            if document["id"] != reference:
                raise OneCEdoError(
                    "invalid_odata_response",
                    "1С вернула посторонний документ для exact id.",
                )
            result.append(document)
    return result


def command_general_get_document(args: argparse.Namespace) -> dict[str, Any]:
    identity, config, credentials = _connected_context()
    kind = str(args.kind)
    reference = _uuid(args.id, "document id")
    line_limit = int(args.line_limit)
    if line_limit < 1 or line_limit > GENERAL_MAX_LINES:
        raise OneCEdoError(
            "line_limit_out_of_range",
            f"line-limit должен быть от 1 до {GENERAL_MAX_LINES}.",
        )
    try:
        schema = _verify_general_schema(
            config,
            credentials,
            (("document", kind),),
        )
        matches = _general_documents_by_id(
            config,
            credentials,
            kind,
            reference,
            include_lines=bool(args.include_lines),
            line_limit=line_limit,
        )
        save_access_state(identity, config, "connected")
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    if len(matches) > 1:
        raise OneCEdoError(
            "ambiguous_document",
            "Один UUID найден в нескольких фиксированных типах документа.",
        )
    return {
        "kind": kind,
        "document": matches[0] if matches else None,
        "matchedBy": ["id"],
        "schema": schema,
        "limits": {"maxLines": GENERAL_MAX_LINES},
    }


def command_general_get_balances(args: argparse.Namespace) -> dict[str, Any]:
    # The standard publication exposes no verified bounded virtual balance
    # table for this deployment.  Movements must never be summed as a fake
    # stock balance.
    return {
        "kind": str(args.kind),
        "status": "unsupported",
        "reason": "needs_custom_endpoint",
        "balances": [],
        "readOnly": True,
    }


def _general_contract_documents(
    config: CompanyConfig,
    credentials: Credentials,
    contract_ids: Iterable[str],
) -> tuple[list[dict[str, Any]], bool]:
    normalized_ids = tuple(contract_ids)
    if not normalized_ids or len(normalized_ids) > GENERAL_MAX_LINK_CONTRACTS:
        raise OneCEdoError(
            "query_builder_error",
            "Внутренний links query получил недопустимый batch договоров.",
        )
    contract_filter = " or ".join(
        f"Договор_Key eq guid'{_uuid(contract_id, 'contract id')}'"
        for contract_id in normalized_ids
    )
    result: list[dict[str, Any]] = []
    saturated = False
    for kind, specs in GENERAL_DOCUMENT_SPECS.items():
        for spec in specs:
            if "Договор_Key" not in spec["fields"]:
                continue
            remaining = GENERAL_MAX_LINK_DOCUMENTS - len(result)
            if remaining <= 0:
                saturated = True
                return result, saturated
            rows = _bounded_odata_rows(
                config,
                credentials,
                spec["entity"],
                parameters=(
                    ("$select", _general_document_select(spec, False)),
                    ("$filter", f"({contract_filter}) and DeletionMark eq false"),
                    ("$orderby", "Date desc"),
                ),
                limit=remaining,
                diagnostic_stage=f"general.document.{kind}.links",
            )
            saturated = saturated or len(rows) >= remaining
            result.extend(
                _general_document_record(
                    kind,
                    spec,
                    row,
                    matched_by=["contract"],
                    include_lines=False,
                    line_limit=0,
                )
                for row in rows[:remaining]
            )
    return result[:GENERAL_MAX_LINK_DOCUMENTS], saturated


def _general_contract_edo_documents(
    config: CompanyConfig,
    credentials: Credentials,
    contract_ids: Iterable[str],
) -> tuple[list[dict[str, Any]], bool]:
    normalized_ids = tuple(contract_ids)
    if not normalized_ids or len(normalized_ids) > GENERAL_MAX_LINK_CONTRACTS:
        raise OneCEdoError(
            "query_builder_error",
            "Внутренний EDO links query получил недопустимый batch договоров.",
        )
    result: list[dict[str, Any]] = []
    saturated = False
    for direction, entity in DOCUMENT_ENTITIES.items():
        remaining = GENERAL_MAX_LINK_EDO_DOCUMENTS - len(result)
        if remaining <= 0:
            saturated = True
            break
        contract_filter = " or ".join(
            (
                "ДоговорКонтрагента eq "
                f"cast(guid'{_uuid(contract_id, 'contract id')}', '{CONTRACT_ENTITY}')"
            )
            for contract_id in normalized_ids
        )
        rows = _bounded_odata_rows(
            config,
            credentials,
            entity,
            parameters=(
                ("$select", _selected_fields(DOCUMENT_SELECT_FIELDS)),
                ("$filter", contract_filter),
                ("$orderby", "Date desc"),
            ),
            limit=remaining,
            diagnostic_stage=f"general.links.edo.{direction}",
        )
        saturated = saturated or len(rows) >= remaining
        for row in rows[:remaining]:
            safe = _safe_selected_record(row, DOCUMENT_SELECT_FIELDS)
            reference = _general_uuid_value(safe.get("Ref_Key"), "EDO document id")
            if reference is None:
                continue
            result.append({
                "id": reference,
                "direction": direction,
                "number": _general_text(
                    safe.get("НомерДокумента") or safe.get("Number"),
                ),
                "date": _normalized_1c_datetime(
                    safe.get("ДатаДокумента") or safe.get("Date"),
                    field_label="EDO document date",
                ),
                "matchedBy": ["contract"],
                "source": {
                    "kind": "edo_document",
                    "type": direction,
                    "id": reference,
                },
            })
    return result[:GENERAL_MAX_LINK_EDO_DOCUMENTS], saturated


def command_general_get_links(args: argparse.Namespace) -> dict[str, Any]:
    identity, config, credentials = _connected_context()
    link_kind = str(args.kind)
    reference = _uuid(args.id, f"{link_kind} id")
    all_schema_capabilities = [
        ("reference", "contract"),
        *(("document", kind) for kind in GENERAL_DOCUMENT_SPECS),
    ]
    if link_kind == "business_unit":
        all_schema_capabilities.append(("reference", "business_unit"))
    try:
        schema = _verify_general_schema(
            config,
            credentials,
            all_schema_capabilities,
        )
        business_unit: dict[str, Any] | None = None
        contracts: list[dict[str, Any]] = []
        documents: list[dict[str, Any]] = []
        edo_documents: list[dict[str, Any]] = []
        contracts_truncated = False
        documents_truncated = False
        edo_truncated = False

        contract_ids: list[str] = []
        if link_kind == "business_unit":
            enterprise_spec = GENERAL_REFERENCE_SPECS["business_unit"][0]
            business_units = _general_reference_by_id(
                config,
                credentials,
                "business_unit",
                reference,
                specs=(enterprise_spec,),
            )
            business_unit = business_units[0] if business_units else None
            if business_unit is not None:
                contract_spec = GENERAL_REFERENCE_SPECS["contract"][0]
                rows = _bounded_odata_rows(
                    config,
                    credentials,
                    contract_spec["entity"],
                    parameters=(
                        ("$select", _selected_fields(contract_spec["fields"])),
                        ("$filter", f"Подразделение_Key eq guid'{reference}' and DeletionMark eq false"),
                        ("$orderby", "Дата desc"),
                    ),
                    limit=GENERAL_MAX_LINK_CONTRACTS,
                    diagnostic_stage="general.links.contracts",
                )
                contracts_truncated = len(rows) >= GENERAL_MAX_LINK_CONTRACTS
                contracts = [
                    _general_reference_record(
                        "contract",
                        contract_spec,
                        row,
                        matched_by=["business_unit"],
                    )
                    for row in rows[:GENERAL_MAX_LINK_CONTRACTS]
                ]
                contract_ids = [item["id"] for item in contracts]
        elif link_kind == "contract":
            matches = _general_reference_by_id(
                config,
                credentials,
                "contract",
                reference,
            )
            contracts = matches[:1]
            contract_ids = [reference] if matches else []
        else:
            found: list[dict[str, Any]] = []
            for kind in GENERAL_DOCUMENT_SPECS:
                found.extend(
                    _general_documents_by_id(
                        config,
                        credentials,
                        kind,
                        reference,
                        include_lines=False,
                        line_limit=0,
                    ),
                )
            if len(found) > 1:
                raise OneCEdoError(
                    "ambiguous_document",
                    "Один UUID найден в нескольких фиксированных типах документа.",
                )
            documents = found
            contract_id = found[0].get("contractId") if found else None
            if isinstance(contract_id, str):
                contract_ids = [contract_id]
                contracts = _general_reference_by_id(
                    config,
                    credentials,
                    "contract",
                    contract_id,
                )[:1]

        if contract_ids:
            remaining_documents = GENERAL_MAX_LINK_DOCUMENTS - len(documents)
            related, truncated = _general_contract_documents(
                config,
                credentials,
                contract_ids,
            )
            known = {(item["type"], item["id"]) for item in documents}
            for item in related:
                key = (item["type"], item["id"])
                if key not in known and len(documents) < GENERAL_MAX_LINK_DOCUMENTS:
                    known.add(key)
                    documents.append(item)
            documents_truncated = (
                documents_truncated
                or truncated
                or len(related) > remaining_documents
            )
            related_edo, truncated_edo = _general_contract_edo_documents(
                config,
                credentials,
                contract_ids,
            )
            known_edo = {(item["direction"], item["id"]) for item in edo_documents}
            for item in related_edo:
                key = (item["direction"], item["id"])
                if (
                    key not in known_edo
                    and len(edo_documents) < GENERAL_MAX_LINK_EDO_DOCUMENTS
                ):
                    known_edo.add(key)
                    edo_documents.append(item)
            edo_truncated = edo_truncated or truncated_edo
        save_access_state(identity, config, "connected")
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    return {
        "kind": link_kind,
        "id": reference,
        "businessUnit": business_unit,
        "contracts": contracts,
        "documents": documents[:GENERAL_MAX_LINK_DOCUMENTS],
        "edoDocuments": edo_documents[:GENERAL_MAX_LINK_EDO_DOCUMENTS],
        "matchedBy": ["id"],
        "schema": schema,
        "limits": {
            "maxContracts": GENERAL_MAX_LINK_CONTRACTS,
            "maxDocuments": GENERAL_MAX_LINK_DOCUMENTS,
            "maxEdoDocuments": GENERAL_MAX_LINK_EDO_DOCUMENTS,
        },
        "truncation": {
            "contracts": contracts_truncated,
            "documents": documents_truncated,
            "edoDocuments": edo_truncated,
        },
        "edoFiles": {
            "included": False,
            "reason": "use_1c_edo_skill",
        },
    }


def build_edo_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="trelio-1c-edo",
        description="Read-only local 1C EDO runtime.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    connect = subparsers.add_parser("connect")
    connect.set_defaults(handler=command_connect)
    doctor = subparsers.add_parser("doctor")
    doctor.set_defaults(handler=command_doctor)

    access = subparsers.add_parser("access-status")
    access_subparsers = access.add_subparsers(dest="access_command", required=True)
    access_show = access_subparsers.add_parser("show")
    access_show.set_defaults(handler=command_access_show)
    access_set = access_subparsers.add_parser("set")
    access_set.add_argument("status", choices=["no-access"])
    access_set.add_argument("--confirmed", action="store_true")
    access_set.set_defaults(handler=command_access_no_access)
    access_reset = access_subparsers.add_parser("reset")
    access_reset.set_defaults(handler=command_access_reset)

    search = subparsers.add_parser("search-documents")
    search.add_argument("--direction", choices=["incoming", "outgoing", "both"], default="both")
    search.add_argument("--query", default="")
    search.set_defaults(handler=command_search_documents)

    get_document = subparsers.add_parser("get-document")
    get_document.add_argument("--direction", choices=["incoming", "outgoing"], required=True)
    get_document.add_argument("--document-id", required=True)
    get_document.set_defaults(handler=command_get_document)

    list_files = subparsers.add_parser("list-files")
    list_files.add_argument("--direction", choices=["incoming", "outgoing"], required=True)
    list_files.add_argument("--document-id", required=True)
    list_files.set_defaults(handler=command_list_files)

    download = subparsers.add_parser("download-file")
    download.add_argument("--scheme", choices=["new", "old"], required=True)
    download.add_argument("--file-id", required=True)
    download.add_argument("--output", required=True)
    download.set_defaults(handler=command_download_file)

    forget = subparsers.add_parser("forget-credentials")
    forget.set_defaults(handler=command_forget_credentials)
    return parser


def build_general_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="trelio-1c",
        description="Broad read-only local 1C business runtime.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    capabilities = subparsers.add_parser("get-capabilities")
    capabilities.set_defaults(handler=command_general_get_capabilities)

    reference_kinds = tuple(GENERAL_REFERENCE_SPECS)
    search_reference = subparsers.add_parser("search-reference-items")
    search_reference.add_argument("--kind", choices=reference_kinds, required=True)
    search_reference.add_argument("--query", default="")
    search_reference.add_argument("--page", type=int, default=1)
    search_reference.add_argument("--limit", type=int, default=25)
    search_reference.set_defaults(handler=command_general_search_reference_items)

    get_reference = subparsers.add_parser("get-reference-item")
    get_reference.add_argument("--kind", choices=reference_kinds, required=True)
    get_reference.add_argument("--id", required=True)
    get_reference.set_defaults(handler=command_general_get_reference_item)

    document_kinds = tuple(GENERAL_DOCUMENT_SPECS)
    search_documents = subparsers.add_parser("search-documents")
    search_documents.add_argument("--kind", choices=document_kinds, required=True)
    search_documents.add_argument("--date-from", default="")
    search_documents.add_argument("--date-to", default="")
    search_documents.add_argument("--organization-id", default="")
    search_documents.add_argument("--business-unit-id", default="")
    search_documents.add_argument("--counterparty-id", default="")
    search_documents.add_argument("--contract-id", default="")
    search_documents.add_argument("--number", default="")
    search_documents.add_argument(
        "--status",
        choices=["", "posted", "unposted", "deleted"],
        default="",
    )
    search_documents.add_argument("--page", type=int, default=1)
    search_documents.add_argument("--limit", type=int, default=25)
    search_documents.set_defaults(handler=command_general_search_documents)

    get_document = subparsers.add_parser("get-document")
    get_document.add_argument("--kind", choices=document_kinds, required=True)
    get_document.add_argument("--id", required=True)
    get_document.add_argument("--include-lines", action="store_true")
    get_document.add_argument("--line-limit", type=int, default=50)
    get_document.set_defaults(handler=command_general_get_document)

    balances = subparsers.add_parser("get-balances")
    balances.add_argument("--kind", choices=["stock"], required=True)
    balances.set_defaults(handler=command_general_get_balances)

    links = subparsers.add_parser("get-links")
    links.add_argument(
        "--kind",
        choices=["business_unit", "contract", "document"],
        required=True,
    )
    links.add_argument("--id", required=True)
    links.set_defaults(handler=command_general_get_links)
    return parser


def build_parser(skill_id: str | None = None) -> argparse.ArgumentParser:
    resolved_skill_id = skill_id or current_skill_id()
    if resolved_skill_id == VKUS_SKILL_ID:
        return build_general_parser()
    raise OneCEdoError(
        "invalid_host_context",
        "Runtime запущен не для поддерживаемой поверхности 1С.",
    )


def _safe_message(error: BaseException) -> str:
    message = str(error).replace("\r", " ").replace("\n", " ").strip()
    return message[:MAX_ERROR_MESSAGE_CHARS] or "Неизвестная ошибка runtime."


def _safe_error_payload(error: OneCEdoError) -> dict[str, Any]:
    """Serialize only the deliberately bounded agent-visible error contract."""

    payload: dict[str, Any] = {
        "code": error.code,
        "message": _safe_message(error),
    }
    if error.details:
        payload["details"] = dict(error.details)
    return payload


def main(
    argv: list[str] | None = None,
    *,
    expected_skill_id: str | None = None,
) -> int:
    try:
        skill_id = current_skill_id()
        if expected_skill_id is not None and skill_id != expected_skill_id:
            raise OneCEdoError(
                "invalid_host_context",
                "Entrypoint и skill identity не совпадают.",
            )
        parser = build_parser(skill_id)
        args = parser.parse_args(argv)
        result = args.handler(args)
        print(json.dumps({"ok": True, **result}, ensure_ascii=False, separators=(",", ":")))
        return 0
    except OneCEdoError as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": _safe_error_payload(error),
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        return error.exit_code
    except KeyboardInterrupt:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": {"code": "cancelled", "message": "Операция отменена."},
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        return 130
    except Exception:
        # Unexpected library/platform failures must not emit a traceback that
        # could contain a local path, URL or credential-bearing header. The
        # detailed exception remains deliberately outside agent-visible output.
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": {
                        "code": "internal_error",
                        "message": "Runtime завершился с безопасной внутренней ошибкой.",
                    },
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
