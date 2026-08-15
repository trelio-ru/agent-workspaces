#!/usr/bin/env python3
"""Company-private read-only 1C runtime for Trelio's Vkus integration.

The runtime deliberately separates three trust domains:

* Trelio supplies normalized non-secret company configuration through the
  signed package host;
* the shared ``X-OData`` value arrives only through a one-use Agent Secret
  checkout environment variable;
* personal 1C credentials are entered locally and stay in a private namespace
  outside chat, MCP, Agent Workspaces, process arguments and Git.

Only a fixed set of GET/HEAD requests can be built below. There is no generic
URL, entity, OData expression or HTTP-method escape hatch.

The production runtime never contacts a schema-discovery route. Its exact
entity, field, line and filter contract is frozen in the signed registry below.
Every business response is validated against that registry before it can be
normalized. Metadata inventory is a separate development/release activity and
is deliberately absent from this executable package.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import datetime as dt
from decimal import Decimal
import email.utils
import getpass
import hashlib
import http.server
import ipaddress
import json
import math
import os
import re
import secrets
import socket
import ssl
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Iterable, Mapping


VKUS_SKILL_ID = "company-33638f79-4d63-47f8-ab40-55ed70331592-1c-vkus"
SUPPORTED_SKILL_IDS = frozenset({VKUS_SKILL_ID})
# The broad Vkus surface owns its connection and local credentials. There is
# intentionally no lookup or migration from the former 1c-edo namespace.
CREDENTIAL_PROVIDER_NAMESPACE = "1c-vkus"
RUNTIME_VERSION = "1.2.2"
X_ODATA_ENV = "TRELIO_1C_EDO_X_ODATA"
CONNECTION_CONFIG_ENV = "TRELIO_SKILL_CONNECTION_CONFIG_JSON"
ACCESS_STATES = ("unknown", "no_access", "connected", "needs_reconnect")
MAX_PROMPT_BODY_BYTES = 8 * 1024
MAX_USERNAME_CHARS = 512
MAX_PASSWORD_CHARS = 2_048
BROWSER_LOAD_TIMEOUT_SECONDS = 8
BROWSER_INPUT_TIMEOUT_SECONDS = 5 * 60
MAX_RATE_LIMIT_RETRIES = 2
FALLBACK_RATE_LIMIT_DELAY_SECONDS = 1.0
MAX_FALLBACK_RATE_LIMIT_DELAY_SECONDS = 4.0
MAX_RATE_LIMIT_WAIT_SECONDS = 30.0
MAX_RATE_LIMIT_TOTAL_WAIT_SECONDS = 30.0
MAX_RETRY_AFTER_HEADER_CHARS = 128
RATE_LIMIT_JITTER_MILLISECONDS = 250
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
# The broad links command may return only a normalized EDO identifier and
# transition hint. These fixed source fields are part of the same signed Vkus
# registry; attachment contents remain exclusively in the `1c-edo` skill.
GENERAL_EDO_LINK_FIELDS = {
    "Ref_Key": "Edm.Guid",
    "Number": "Edm.String",
    "Date": "Edm.DateTime",
    "ВидДокумента_Key": "Edm.Guid",
    "ДатаДокумента": "Edm.DateTime",
    "ДатаПодписания": "Edm.DateTime",
    "ДоговорКонтрагента": "Edm.Guid",
    "Комментарий": "Edm.String",
    "Контрагент": "Edm.Guid",
    "НомерДокумента": "Edm.String",
    "ОбменБезПодписи": "Edm.Boolean",
    "Организация_Key": "Edm.Guid",
    "Остановлен": "Edm.Boolean",
    "СуммаДокумента": "Edm.Double",
}
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
ZERO_UUID = "00000000-0000-0000-0000-000000000000"
MAX_ODATA_RESPONSE_BYTES = 8 * 1024 * 1024
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
                "account",
                "cash_flow_item",
                "other_expense_item",
                "expense_allocation_rule",
                "budget_item",
                "unit",
            )
            for action in ("search", "get")
        },
        *{
            f"general.document.{kind}.{action}"
            for kind in (
                "purchase",
                "sale",
                "receipt",
                "return",
                "transfer",
                "internal_consumption",
                "service_purchase",
                "expense_report",
            )
            for action in ("search", "get", "links")
        },
        *{
            f"general.financial.turnover.{kind}.search"
            for kind in (
                "sales_cost",
                "other_income",
                "other_expense",
                "financial_result",
                "payroll_accounting",
                "insurance_contribution",
                "depreciation",
                "tax_settlement",
                "tax_penalty",
                "budget",
            )
        },
        *{
            f"general.financial.record.{kind}.search"
            for kind in (
                "account_entry",
                "bank_receipt",
                "bank_payment",
            )
        },
        "general.balance.accounts.search",
        "general.balance.stock.search",
    },
)

# The production broad 1C surface is intentionally frozen to the exact
# entities and EDM field types reviewed from a development-only inventory on
# 2026-07-28. Only fields listed here can enter a query or normalized response.
# Contacts, binary fields, personal payroll identifiers and bank-account
# requisites remain deliberately absent. Release 1.0.17 adds only bounded
# normalized finance aggregates, accounting/stock balance virtual tables and
# bank-document headers needed as source data for later governed reporting.
#
# The profile digest is provenance for that release review. Production does
# not fetch the source metadata document and instead validates every returned
# record against the signed types below.
GENERAL_PROFILE_SCHEMA_DIGEST = (
    "sha256:24fdf38337a373147df742a235b9bc025f45616e4f0753fe06dc769bda45353b"
)
GENERAL_REGISTRY_VERSION = 5
# These ceilings still bound every read-only command, but allow a full annual
# management-accounting pass without forcing the economist to split one
# logical request into quarters or manually stitch tiny document pages.  The
# effective page size/page count remains the lower of these signed limits and
# the live company connection policy, so an administrator can tighten the
# deployment without publishing another runtime.
GENERAL_MAX_PAGE_SIZE = 50
GENERAL_MAX_PAGES = 10
GENERAL_MAX_LINES = 500
GENERAL_MAX_FINANCIAL_PAGE_SIZE = 50
GENERAL_MAX_FINANCIAL_PERIOD_DAYS = 366
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
    "account": (
        {
            "entity": "ChartOfAccounts_Хозрасчетный",
            "sourceType": "general_ledger_account",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Description": "Edm.String",
                "Code": "Edm.String",
                "Parent_Key": "Edm.Guid",
                "OffBalance": "Edm.Boolean",
                "Type": "Edm.String",
                "УчетПоПодразделениям": "Edm.Boolean",
                "УчетПоНаправлениямДеятельности": "Edm.Boolean",
                "НалоговыйУчет": "Edm.Boolean",
                "DeletionMark": "Edm.Boolean",
            },
            "searchFields": ("Description", "Code"),
        },
    ),
    "cash_flow_item": (
        {
            "entity": "Catalog_СтатьиДвиженияДенежныхСредств",
            "sourceType": "cash_flow_item",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Description": "Edm.String",
                "Code": "Edm.String",
                "Parent_Key": "Edm.Guid",
                "IsFolder": "Edm.Boolean",
                "ВидДвиженияДенежныхСредств": "Edm.String",
                "DeletionMark": "Edm.Boolean",
            },
            "searchFields": ("Description", "Code"),
        },
    ),
    "other_expense_item": (
        {
            "entity": "Catalog_ПрочиеРасходы",
            "sourceType": "other_expense_item",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Description": "Edm.String",
                "Owner_Key": "Edm.Guid",
                "Parent_Key": "Edm.Guid",
                "IsFolder": "Edm.Boolean",
                "DeletionMark": "Edm.Boolean",
            },
            "searchFields": ("Description",),
        },
    ),
    "expense_allocation_rule": (
        {
            "entity": "Catalog_ПравилаРаспределенияРасходов",
            "sourceType": "expense_allocation_rule",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Description": "Edm.String",
                "DeletionMark": "Edm.Boolean",
                "НазначениеПравила": "Edm.String",
                "БазаРаспределения": "Edm.String",
                "ПредставлениеПравила": "Edm.String",
                "РаспределятьНаСтатьи": "Edm.Boolean",
                "РаспределятьПоПодразделениям": "Edm.Boolean",
                "ПодразделенияУказаныВручную": "Edm.Boolean",
                "Подразделение_Key": "Edm.Guid",
                "Устаревшее": "Edm.Boolean",
            },
            "searchFields": ("Description", "ПредставлениеПравила"),
        },
    ),
    "budget_item": (
        {
            # The P&L drill-down labels these rows as articles, but live 1C
            # stores the selected value in the expense-article chart rather
            # than in Catalog_СтатьиБюджетов.  Preserve the public
            # ``budget_item`` kind for command compatibility while freezing
            # the actual reviewed source and its scalar fields here.
            "entity": "ChartOfCharacteristicTypes_СтатьиРасходов",
            "sourceType": "expense_item",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Description": "Edm.String",
                "Code": "Edm.String",
                "Parent_Key": "Edm.Guid",
                "IsFolder": "Edm.Boolean",
                "DeletionMark": "Edm.Boolean",
            },
            "searchFields": ("Description", "Code"),
        },
    ),
    "unit": (
        {
            "entity": "Catalog_УпаковкиЕдиницыИзмерения",
            "sourceType": "unit",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Description": "Edm.String",
                "Code": "Edm.String",
                "НаименованиеПолное": "Edm.String",
                "ЕдиницаИзмерения_Key": "Edm.Guid",
                "МеждународноеСокращение": "Edm.String",
                "DeletionMark": "Edm.Boolean",
            },
            "searchFields": (
                "Description",
                "Code",
                "НаименованиеПолное",
                "МеждународноеСокращение",
            ),
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
                "СуммаСНДС": "Edm.Double",
                "СтатьяРасходов_Key": "Edm.Guid",
                "СписатьНаРасходы": "Edm.Boolean",
                "ИдентификаторСтроки": "Edm.String",
                "НаименованиеВходящегоДокумента": "Edm.String",
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
    "service_purchase": (
        {
            "entity": "Document_ПриобретениеУслугПрочихАктивов",
            "sourceType": "service_purchase",
            "lineCollection": "Расходы",
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
                "СуммаДокумента": "Edm.Double",
                "Комментарий": "Edm.String",
                "Расходы": (
                    "Collection(StandardODATA."
                    "Document_ПриобретениеУслугПрочихАктивов_Расходы_RowType)"
                ),
            },
            "lineFields": {
                "LineNumber": "Edm.Int64",
                "Содержание": "Edm.String",
                "Количество": "Edm.Double",
                "Цена": "Edm.Double",
                "Сумма": "Edm.Double",
                "СуммаНДС": "Edm.Double",
                "СуммаСНДС": "Edm.Double",
                "СтатьяРасходов": "Edm.String",
                "СтатьяРасходов_Type": "Edm.String",
                "Подразделение_Key": "Edm.Guid",
                "КомментарийРаспределения": "Edm.String",
                "ИдентификаторСтроки": "Edm.String",
            },
            "filters": (
                "period",
                "organization",
                "business_unit",
                "counterparty",
                "contract",
                "number",
                "status",
            ),
        },
    ),
    "expense_report": (
        {
            "entity": "Document_АвансовыйОтчет",
            "sourceType": "expense_report",
            "lineCollection": "ПрочиеРасходы",
            "amountField": "СуммаИзрасходовано",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Number": "Edm.String",
                "Date": "Edm.DateTime",
                "DeletionMark": "Edm.Boolean",
                "Posted": "Edm.Boolean",
                "Организация_Key": "Edm.Guid",
                "Подразделение_Key": "Edm.Guid",
                "СуммаИзрасходовано": "Edm.Double",
                "НазначениеАванса": "Edm.String",
                "Статус": "Edm.String",
                "Комментарий": "Edm.String",
                "ДатаУтверждения": "Edm.DateTime",
                "ПрочиеРасходы": (
                    "Collection(StandardODATA."
                    "Document_АвансовыйОтчет_ПрочиеРасходы_RowType)"
                ),
            },
            "lineFields": {
                "LineNumber": "Edm.Int64",
                "НаименованиеВходящегоДокумента": "Edm.String",
                "НомерВходящегоДокумента": "Edm.String",
                "ДатаВходящегоДокумента": "Edm.DateTime",
                "Сумма": "Edm.Double",
                "СуммаНДС": "Edm.Double",
                "СуммаСНДС": "Edm.Double",
                "СтатьяРасходов": "Edm.String",
                "СтатьяРасходов_Type": "Edm.String",
                "Комментарий": "Edm.String",
                "Содержание": "Edm.String",
                "ИдентификаторСтроки": "Edm.String",
                "Подразделение_Key": "Edm.Guid",
                "Контрагент_Key": "Edm.Guid",
                "Отменено": "Edm.Boolean",
                "ПричинаОтмены": "Edm.String",
            },
            "filters": (
                "period",
                "organization",
                "business_unit",
                "number",
                "status",
            ),
        },
    ),
    "internal_consumption": (
        {
            "entity": "Document_ВнутреннееПотребление",
            "sourceType": "internal_consumption",
            "fields": {
                "Ref_Key": "Edm.Guid",
                "Number": "Edm.String",
                "Date": "Edm.DateTime",
                "DeletionMark": "Edm.Boolean",
                "Posted": "Edm.Boolean",
                "Организация_Key": "Edm.Guid",
                "Подразделение_Key": "Edm.Guid",
                "Склад_Key": "Edm.Guid",
                "ХозяйственнаяОперация": "Edm.String",
                "Статус": "Edm.String",
                "Товары": (
                    "Collection(StandardODATA."
                    "Document_ВнутреннееПотребление_Товары_RowType)"
                ),
            },
            # The document itself does not expose line amounts. The runtime
            # enriches these fixed goods rows only from the reviewed budget
            # register records of this exact registrar; no caller-selected
            # entity, join, field or expression is accepted.
            "lineFields": {
                "LineNumber": "Edm.Int64",
                "Номенклатура_Key": "Edm.Guid",
                "Характеристика_Key": "Edm.Guid",
                "Упаковка_Key": "Edm.Guid",
                "Количество": "Edm.Double",
                "СтатьяРасходов": "Edm.String",
                "СтатьяРасходов_Type": "Edm.String",
                "ИдентификаторСтроки": "Edm.String",
            },
            "filters": (
                "period",
                "organization",
                "business_unit",
                "number",
                "status",
            ),
        },
    ),
}

# These finance profiles expose source data, not a P&L calculation. Most use
# virtual tables; the budget profile uses a fixed read-only record table so
# registrar identity is retained. Every route, grouping dimension, output
# field and caller-visible semantic key
# is frozen from the reviewed Vkus metadata digest above. The caller supplies
# only a bounded period and validated UUID filters; it cannot choose a
# register, function, dimension, field or OData expression.
GENERAL_FINANCIAL_TURNOVER_SPECS: dict[str, dict[str, Any]] = {
    "budget": {
        "entity": "AccumulationRegister_ПрочиеРасходы_RecordType",
        "transport": "record_table",
        "sourceType": "expense_records_by_registrar",
        # Direct source documents and the later month-end distribution both
        # write this register. Keep all active registrar types in the signed
        # source, classify them below and reconcile direct rows against the
        # independent distribution control. Filtering to one document type
        # would make missing expenses look like a complete article.
        "fields": {
            "Recorder": "Edm.String",
            "Recorder_Type": "Edm.String",
            "Period": "Edm.DateTime",
            "LineNumber": "Edm.Int64",
            "Active": "Edm.Boolean",
            "СтатьяРасходов_Key": "Edm.Guid",
            "Подразделение_Key": "Edm.Guid",
            "АналитикаУчетаНоменклатуры_Key": "Edm.Guid",
            "Сумма": "Edm.Double",
            "СуммаБезНДС": "Edm.Double",
            "СуммаУпр": "Edm.Double",
            "СуммаРегл": "Edm.Double",
        },
        "output": {
            "Recorder": "registrarReference",
            "Recorder_Type": "registrarType",
            "Period": "period",
            "LineNumber": "lineNumber",
            "Active": "active",
            "СтатьяРасходов_Key": "budgetItemReference",
            "Подразделение_Key": "businessUnitId",
            "АналитикаУчетаНоменклатуры_Key": "itemAccountingAnalyticsId",
            "Сумма": "amountSource",
            "СуммаБезНДС": "amountWithoutVat",
            "СуммаУпр": "amount",
            "СуммаРегл": "amountRegulated",
        },
        "metrics": (
            "Сумма",
            "СуммаБезНДС",
            "СуммаУпр",
            "СуммаРегл",
        ),
        "dateField": "Period",
        "stateClauses": ("Active eq true",),
        "filters": {
            "business_unit": ("Подразделение_Key",),
            "budget_item": ("СтатьяРасходов_Key",),
        },
        "filterSourceTypes": {"business_unit": "enterprise_structure"},
        "requiredAny": ("business_unit",),
    },
    "sales_cost": {
        "entity": "AccumulationRegister_ВыручкаИСебестоимостьПродаж",
        "function": "Turnovers",
        "sourceType": "sales_and_cost_turnovers",
        "dimensions": ("Подразделение", "ХозяйственнаяОперация"),
        "fields": {
            "Подразделение_Key": "Edm.Guid",
            "ХозяйственнаяОперация": "Edm.String",
            "КоличествоTurnover": "Edm.Double",
            "СуммаВыручкиTurnover": "Edm.Double",
            "СуммаВыручкиБезНДСTurnover": "Edm.Double",
            "СтоимостьTurnover": "Edm.Double",
            "СтоимостьБезНДСTurnover": "Edm.Double",
            "ДопРасходыTurnover": "Edm.Double",
            "ДопРасходыБезНДСTurnover": "Edm.Double",
            "СуммаВыручкиРеглTurnover": "Edm.Double",
            "РасходыНаПродажуБезНДСTurnover": "Edm.Double",
            "СуммаРучнойСкидкиTurnover": "Edm.Double",
            "СуммаАвтоматическойСкидкиTurnover": "Edm.Double",
        },
        "output": {
            "Подразделение_Key": "businessUnitId",
            "ХозяйственнаяОперация": "operation",
            "КоличествоTurnover": "quantity",
            "СуммаВыручкиTurnover": "revenueWithVat",
            "СуммаВыручкиБезНДСTurnover": "revenueWithoutVat",
            "СтоимостьTurnover": "costWithVat",
            "СтоимостьБезНДСTurnover": "costWithoutVat",
            "ДопРасходыTurnover": "additionalCostWithVat",
            "ДопРасходыБезНДСTurnover": "additionalCostWithoutVat",
            "СуммаВыручкиРеглTurnover": "regulatedRevenue",
            "РасходыНаПродажуБезНДСTurnover": "sellingExpenseWithoutVat",
            "СуммаРучнойСкидкиTurnover": "manualDiscount",
            "СуммаАвтоматическойСкидкиTurnover": "automaticDiscount",
        },
        "metrics": (
            "КоличествоTurnover",
            "СуммаВыручкиTurnover",
            "СуммаВыручкиБезНДСTurnover",
            "СтоимостьTurnover",
            "СтоимостьБезНДСTurnover",
            "ДопРасходыTurnover",
            "ДопРасходыБезНДСTurnover",
            "СуммаВыручкиРеглTurnover",
            "РасходыНаПродажуБезНДСTurnover",
            "СуммаРучнойСкидкиTurnover",
            "СуммаАвтоматическойСкидкиTurnover",
        ),
        "filters": {"business_unit": ("Подразделение_Key",)},
        "filterSourceTypes": {"business_unit": "enterprise_structure"},
        "requiredAny": ("business_unit",),
    },
    "other_income": {
        "entity": "AccumulationRegister_ПрочиеДоходы",
        "function": "Turnovers",
        "sourceType": "other_income_turnovers",
        "dimensions": (
            "Организация",
            "Подразделение",
            "НаправлениеДеятельности",
            "СтатьяДоходов",
        ),
        "fields": {
            "Организация_Key": "Edm.Guid",
            "Подразделение_Key": "Edm.Guid",
            "НаправлениеДеятельности_Key": "Edm.Guid",
            "СтатьяДоходов_Key": "Edm.Guid",
            "СуммаTurnover": "Edm.Double",
            "СуммаРеглTurnover": "Edm.Double",
            "СуммаУпрTurnover": "Edm.Double",
        },
        "output": {
            "Организация_Key": "organizationId",
            "Подразделение_Key": "businessUnitId",
            "НаправлениеДеятельности_Key": "businessDirectionId",
            "СтатьяДоходов_Key": "incomeItemId",
            "СуммаTurnover": "amount",
            "СуммаРеглTurnover": "regulatedAmount",
            "СуммаУпрTurnover": "managementAmount",
        },
        "metrics": ("СуммаTurnover", "СуммаРеглTurnover", "СуммаУпрTurnover"),
        "filters": {
            "organization": ("Организация_Key",),
            "business_unit": ("Подразделение_Key",),
        },
        "filterSourceTypes": {"business_unit": "enterprise_structure"},
        "requiredAny": ("organization", "business_unit"),
    },
    "other_expense": {
        "entity": "AccumulationRegister_ПрочиеРасходы",
        "function": "Turnovers",
        "sourceType": "other_expense_turnovers",
        "dimensions": (
            "Организация",
            "Подразделение",
            "НаправлениеДеятельности",
            "СтатьяРасходов",
        ),
        "fields": {
            "Организация_Key": "Edm.Guid",
            "Подразделение_Key": "Edm.Guid",
            "НаправлениеДеятельности_Key": "Edm.Guid",
            "СтатьяРасходов_Key": "Edm.Guid",
            "СуммаTurnover": "Edm.Double",
            "СуммаБезНДСTurnover": "Edm.Double",
            "СуммаРеглTurnover": "Edm.Double",
            "СуммаУпрTurnover": "Edm.Double",
        },
        "output": {
            "Организация_Key": "organizationId",
            "Подразделение_Key": "businessUnitId",
            "НаправлениеДеятельности_Key": "businessDirectionId",
            "СтатьяРасходов_Key": "expenseItemId",
            "СуммаTurnover": "amountWithVat",
            "СуммаБезНДСTurnover": "amountWithoutVat",
            "СуммаРеглTurnover": "regulatedAmount",
            "СуммаУпрTurnover": "managementAmount",
        },
        "metrics": (
            "СуммаTurnover",
            "СуммаБезНДСTurnover",
            "СуммаРеглTurnover",
            "СуммаУпрTurnover",
        ),
        "filters": {
            "organization": ("Организация_Key",),
            "business_unit": ("Подразделение_Key",),
        },
        "filterSourceTypes": {"business_unit": "enterprise_structure"},
        "requiredAny": ("organization", "business_unit"),
    },
    "financial_result": {
        "entity": "AccumulationRegister_ФинансовыеРезультаты",
        "function": "Turnovers",
        "sourceType": "financial_result_turnovers",
        "dimensions": (
            "Организация",
            "Подразделение",
            "НаправлениеДеятельности",
            "СтатьяДоходов",
            "СтатьяРасходов",
        ),
        "fields": {
            "Организация_Key": "Edm.Guid",
            "Подразделение_Key": "Edm.Guid",
            "НаправлениеДеятельности_Key": "Edm.Guid",
            "СтатьяДоходов_Key": "Edm.Guid",
            "СтатьяРасходов_Key": "Edm.Guid",
            "ДоходыTurnover": "Edm.Double",
            "РасходыTurnover": "Edm.Double",
        },
        "output": {
            "Организация_Key": "organizationId",
            "Подразделение_Key": "businessUnitId",
            "НаправлениеДеятельности_Key": "businessDirectionId",
            "СтатьяДоходов_Key": "incomeItemId",
            "СтатьяРасходов_Key": "expenseItemId",
            "ДоходыTurnover": "income",
            "РасходыTurnover": "expense",
        },
        "metrics": ("ДоходыTurnover", "РасходыTurnover"),
        "filters": {
            "organization": ("Организация_Key",),
            "business_unit": ("Подразделение_Key",),
        },
        "filterSourceTypes": {"business_unit": "enterprise_structure"},
        "requiredAny": ("organization", "business_unit"),
    },
    "payroll_accounting": {
        "entity": "AccumulationRegister_НачисленияУдержанияПоСотрудникам",
        "function": "Turnovers",
        "sourceType": "payroll_accrual_and_withholding_turnovers",
        # Physical person and employee are intentionally not grouping
        # dimensions and never enter selected fields. The verified register
        # remains useful for a pizzeria P&L because it exposes organization,
        # business unit, expense/funding articles, operation type and amount.
        "dimensions": (
            "Организация",
            "Подразделение",
            "СтатьяФинансирования",
            "СтатьяРасходов",
            "НачислениеУдержание",
        ),
        "fields": {
            "Организация_Key": "Edm.Guid",
            "Подразделение_Key": "Edm.Guid",
            "СтатьяФинансирования_Key": "Edm.Guid",
            "СтатьяРасходов_Key": "Edm.Guid",
            "НачислениеУдержание": "Edm.String",
            "НачислениеУдержание_Type": "Edm.String",
            "СуммаTurnover": "Edm.Double",
        },
        "output": {
            "Организация_Key": "organizationId",
            "Подразделение_Key": "businessUnitId",
            "СтатьяФинансирования_Key": "fundingItemId",
            "СтатьяРасходов_Key": "expenseItemId",
            "НачислениеУдержание": "accrualOrWithholdingReference",
            "НачислениеУдержание_Type": "accrualOrWithholdingType",
            "СуммаTurnover": "amount",
        },
        "metrics": ("СуммаTurnover",),
        "filters": {
            "organization": ("Организация_Key",),
            "business_unit": ("Подразделение_Key",),
        },
        "filterSourceTypes": {"business_unit": "organization_division"},
        "requiredAny": ("organization", "business_unit"),
    },
    "insurance_contribution": {
        "entity": "AccumulationRegister_ИсчисленныеСтраховыеВзносы",
        "function": "Turnovers",
        "sourceType": "insurance_contribution_turnovers",
        "dimensions": ("Организация",),
        "fields": {
            "Организация_Key": "Edm.Guid",
            "ПФРПоСуммарномуТарифуTurnover": "Edm.Double",
            "ПФРПоСуммарномуТарифуСПревышенияTurnover": "Edm.Double",
            "ФССTurnover": "Edm.Double",
            "ФССНесчастныеСлучаиTurnover": "Edm.Double",
            "ФФОМСTurnover": "Edm.Double",
        },
        "output": {
            "Организация_Key": "organizationId",
            "ПФРПоСуммарномуТарифуTurnover": "pensionContribution",
            "ПФРПоСуммарномуТарифуСПревышенияTurnover": "pensionContributionAboveLimit",
            "ФССTurnover": "socialInsuranceContribution",
            "ФССНесчастныеСлучаиTurnover": "accidentInsuranceContribution",
            "ФФОМСTurnover": "medicalInsuranceContribution",
        },
        "metrics": (
            "ПФРПоСуммарномуТарифуTurnover",
            "ПФРПоСуммарномуТарифуСПревышенияTurnover",
            "ФССTurnover",
            "ФССНесчастныеСлучаиTurnover",
            "ФФОМСTurnover",
        ),
        "filters": {"organization": ("Организация_Key",)},
        "requiredAny": ("organization",),
    },
    "depreciation": {
        "entity": "AccumulationRegister_АмортизацияОС",
        "function": "Turnovers",
        "sourceType": "fixed_asset_depreciation_turnovers",
        "dimensions": (
            "Организация",
            "Подразделение",
            "НаправлениеДеятельности",
        ),
        "fields": {
            "Организация_Key": "Edm.Guid",
            "Подразделение_Key": "Edm.Guid",
            "НаправлениеДеятельности_Key": "Edm.Guid",
            "АмортизацияTurnover": "Edm.Double",
            "АмортизацияРеглTurnover": "Edm.Double",
            "АмортизацияНУTurnover": "Edm.Double",
        },
        "output": {
            "Организация_Key": "organizationId",
            "Подразделение_Key": "businessUnitId",
            "НаправлениеДеятельности_Key": "businessDirectionId",
            "АмортизацияTurnover": "depreciation",
            "АмортизацияРеглTurnover": "regulatedDepreciation",
            "АмортизацияНУTurnover": "taxDepreciation",
        },
        "metrics": (
            "АмортизацияTurnover",
            "АмортизацияРеглTurnover",
            "АмортизацияНУTurnover",
        ),
        "filters": {
            "organization": ("Организация_Key",),
            "business_unit": ("Подразделение_Key",),
        },
        "filterSourceTypes": {"business_unit": "enterprise_structure"},
        "requiredAny": ("organization", "business_unit"),
    },
    "tax_settlement": {
        "entity": "AccumulationRegister_РасчетыПоНалогамНаЕдиномНалоговомСчете",
        "function": "Turnovers",
        "sourceType": "unified_tax_account_turnovers",
        "dimensions": ("Организация", "СчетУчета", "Налог"),
        "fields": {
            "Организация_Key": "Edm.Guid",
            "СчетУчета_Key": "Edm.Guid",
            "Налог": "Edm.String",
            "Налог_Type": "Edm.String",
            "СуммаTurnover": "Edm.Double",
            "СуммаReceipt": "Edm.Double",
            "СуммаExpense": "Edm.Double",
        },
        "output": {
            "Организация_Key": "organizationId",
            "СчетУчета_Key": "accountId",
            "Налог": "taxReference",
            "Налог_Type": "taxReferenceType",
            "СуммаTurnover": "amount",
            "СуммаReceipt": "receipt",
            "СуммаExpense": "expense",
        },
        "metrics": ("СуммаTurnover", "СуммаReceipt", "СуммаExpense"),
        "filters": {"organization": ("Организация_Key",)},
        "requiredAny": ("organization",),
    },
    "tax_penalty": {
        "entity": "AccumulationRegister_РасчетыПоСанкциямНаЕдиномНалоговомСчете",
        "function": "Turnovers",
        "sourceType": "unified_tax_penalty_turnovers",
        "dimensions": ("Организация", "ВидПлатежа"),
        "fields": {
            "Организация_Key": "Edm.Guid",
            "ВидПлатежа": "Edm.String",
            "СуммаTurnover": "Edm.Double",
            "СуммаReceipt": "Edm.Double",
            "СуммаExpense": "Edm.Double",
        },
        "output": {
            "Организация_Key": "organizationId",
            "ВидПлатежа": "paymentType",
            "СуммаTurnover": "amount",
            "СуммаReceipt": "receipt",
            "СуммаExpense": "expense",
        },
        "metrics": ("СуммаTurnover", "СуммаReceipt", "СуммаExpense"),
        "filters": {"organization": ("Организация_Key",)},
        "requiredAny": ("organization",),
    },
}

GENERAL_FINANCIAL_RECORD_SPECS: dict[str, dict[str, Any]] = {
    "account_entry": {
        "entity": "AccountingRegister_Хозрасчетный_RecordType",
        "sourceType": "general_ledger_entry",
        "dateField": "Period",
        "stateClauses": ("Active eq true",),
        "fields": {
            "Recorder": "Edm.String",
            "Recorder_Type": "Edm.String",
            "Period": "Edm.DateTime",
            "LineNumber": "Edm.Int64",
            "Active": "Edm.Boolean",
            "AccountDr_Key": "Edm.Guid",
            "AccountCr_Key": "Edm.Guid",
            "Организация_Key": "Edm.Guid",
            "ПодразделениеDr_Key": "Edm.Guid",
            "ПодразделениеCr_Key": "Edm.Guid",
            "НаправлениеДеятельностиDr_Key": "Edm.Guid",
            "НаправлениеДеятельностиCr_Key": "Edm.Guid",
            "Сумма": "Edm.Double",
            "СуммаУУ": "Edm.Double",
            "СуммаФО": "Edm.Double",
            "Сторно": "Edm.Boolean",
        },
        "output": {
            "Recorder": "sourceDocumentReference",
            "Recorder_Type": "sourceDocumentType",
            "Period": "period",
            "LineNumber": "lineNumber",
            "Active": "active",
            "AccountDr_Key": "debitAccountId",
            "AccountCr_Key": "creditAccountId",
            "Организация_Key": "organizationId",
            "ПодразделениеDr_Key": "debitBusinessUnitId",
            "ПодразделениеCr_Key": "creditBusinessUnitId",
            "НаправлениеДеятельностиDr_Key": "debitBusinessDirectionId",
            "НаправлениеДеятельностиCr_Key": "creditBusinessDirectionId",
            "Сумма": "amount",
            "СуммаУУ": "managementAmount",
            "СуммаФО": "financialAmount",
            "Сторно": "reversal",
        },
        "metrics": ("Сумма", "СуммаУУ", "СуммаФО"),
        "filters": {
            "organization": ("Организация_Key",),
            "business_unit": ("ПодразделениеDr_Key", "ПодразделениеCr_Key"),
            "account": ("AccountDr_Key", "AccountCr_Key"),
        },
        "filterSourceTypes": {"business_unit": "enterprise_structure"},
        "requiredAny": ("organization", "business_unit", "account"),
    },
    "bank_receipt": {
        "entity": "Document_ПоступлениеБезналичныхДенежныхСредств",
        "sourceType": "bank_receipt",
        "dateField": "Date",
        "stateClauses": ("DeletionMark eq false", "Posted eq true"),
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
            "Валюта_Key": "Edm.Guid",
            "СтатьяДвиженияДенежныхСредств_Key": "Edm.Guid",
            "НаправлениеДеятельности_Key": "Edm.Guid",
            "СуммаДокумента": "Edm.Double",
            "СуммаКомиссии": "Edm.Double",
            "СтатьяРасходов_Key": "Edm.Guid",
            "ПеречислениеВБюджет": "Edm.Boolean",
            "ТипНалога_Key": "Edm.Guid",
            "ХозяйственнаяОперация": "Edm.String",
            "ОтражатьКомиссию": "Edm.Boolean",
        },
        "output": {
            "Ref_Key": "id",
            "Number": "number",
            "Date": "date",
            "DeletionMark": "deleted",
            "Posted": "posted",
            "Организация_Key": "organizationId",
            "Подразделение_Key": "businessUnitId",
            "Контрагент_Key": "counterpartyId",
            "Партнер_Key": "partnerId",
            "Валюта_Key": "currencyId",
            "СтатьяДвиженияДенежныхСредств_Key": "cashFlowItemId",
            "НаправлениеДеятельности_Key": "businessDirectionId",
            "СуммаДокумента": "amount",
            "СуммаКомиссии": "commissionAmount",
            "СтатьяРасходов_Key": "expenseItemId",
            "ПеречислениеВБюджет": "budgetPayment",
            "ТипНалога_Key": "taxTypeId",
            "ХозяйственнаяОперация": "operation",
            "ОтражатьКомиссию": "commissionRecorded",
        },
        "metrics": ("СуммаДокумента", "СуммаКомиссии"),
        "filters": {
            "organization": ("Организация_Key",),
            "business_unit": ("Подразделение_Key",),
        },
        "filterSourceTypes": {"business_unit": "enterprise_structure"},
        "requiredAny": ("organization", "business_unit"),
    },
    "bank_payment": {
        "entity": "Document_СписаниеБезналичныхДенежныхСредств",
        "sourceType": "bank_payment",
        "dateField": "Date",
        "stateClauses": ("DeletionMark eq false", "Posted eq true"),
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
            "Валюта_Key": "Edm.Guid",
            "СтатьяДвиженияДенежныхСредств_Key": "Edm.Guid",
            "НаправлениеДеятельности_Key": "Edm.Guid",
            "СуммаДокумента": "Edm.Double",
            "СуммаКомиссии": "Edm.Double",
            "СтатьяРасходов_Key": "Edm.Guid",
            "ПеречислениеВБюджет": "Edm.Boolean",
            "ТипНалога_Key": "Edm.Guid",
            "ХозяйственнаяОперация": "Edm.String",
            "ОтражатьКомиссию": "Edm.Boolean",
        },
        "output": {
            "Ref_Key": "id",
            "Number": "number",
            "Date": "date",
            "DeletionMark": "deleted",
            "Posted": "posted",
            "Организация_Key": "organizationId",
            "Подразделение_Key": "businessUnitId",
            "Контрагент_Key": "counterpartyId",
            "Партнер_Key": "partnerId",
            "Валюта_Key": "currencyId",
            "СтатьяДвиженияДенежныхСредств_Key": "cashFlowItemId",
            "НаправлениеДеятельности_Key": "businessDirectionId",
            "СуммаДокумента": "amount",
            "СуммаКомиссии": "commissionAmount",
            "СтатьяРасходов_Key": "expenseItemId",
            "ПеречислениеВБюджет": "budgetPayment",
            "ТипНалога_Key": "taxTypeId",
            "ХозяйственнаяОперация": "operation",
            "ОтражатьКомиссию": "commissionRecorded",
        },
        "metrics": ("СуммаДокумента", "СуммаКомиссии"),
        "filters": {
            "organization": ("Организация_Key",),
            "business_unit": ("Подразделение_Key",),
        },
        "filterSourceTypes": {"business_unit": "enterprise_structure"},
        "requiredAny": ("organization", "business_unit"),
    },
}

GENERAL_BALANCE_SPECS: dict[str, dict[str, Any]] = {
    "accounts": {
        "entity": "AccountingRegister_Хозрасчетный",
        "function": "BalanceAndTurnovers",
        "sourceType": "general_ledger_balance_and_turnovers",
        # Live 1C accepts the virtual table but returns HTTP 500 when this
        # deployment receives an explicit accounting `Dimensions` parameter.
        # Omitting it is the verified route and still returns the fixed regular
        # dimensions below. `$filter`, `$top` and `$skip` remain bounded.
        "dimensions": (),
        "fields": {
            "Account_Key": "Edm.Guid",
            "Организация_Key": "Edm.Guid",
            "Подразделение_Key": "Edm.Guid",
            "НаправлениеДеятельности_Key": "Edm.Guid",
            "СуммаOpeningBalance": "Edm.Double",
            "СуммаTurnoverDr": "Edm.Double",
            "СуммаTurnoverCr": "Edm.Double",
            "СуммаClosingBalance": "Edm.Double",
        },
        "output": {
            "Account_Key": "accountId",
            "Организация_Key": "organizationId",
            "Подразделение_Key": "businessUnitId",
            "НаправлениеДеятельности_Key": "businessDirectionId",
            "СуммаOpeningBalance": "openingBalance",
            "СуммаTurnoverDr": "debitTurnover",
            "СуммаTurnoverCr": "creditTurnover",
            "СуммаClosingBalance": "closingBalance",
        },
        "metrics": (
            "СуммаOpeningBalance",
            "СуммаTurnoverDr",
            "СуммаTurnoverCr",
            "СуммаClosingBalance",
        ),
        "filters": {
            "organization": ("Организация_Key",),
            "business_unit": ("Подразделение_Key",),
            "account": ("Account_Key",),
        },
        "filterSourceTypes": {"business_unit": "enterprise_structure"},
        "requiredAny": ("organization", "business_unit", "account"),
    },
    "stock": {
        "entity": "AccumulationRegister_ТоварыНаСкладах",
        "function": "BalanceAndTurnovers",
        "sourceType": "stock_balance_and_turnovers",
        "dimensions": ("Номенклатура", "Характеристика", "Склад"),
        "fields": {
            "Номенклатура_Key": "Edm.Guid",
            "Характеристика_Key": "Edm.Guid",
            "Склад_Key": "Edm.Guid",
            "ВНаличииOpeningBalance": "Edm.Double",
            "ВНаличииReceipt": "Edm.Double",
            "ВНаличииExpense": "Edm.Double",
            "ВНаличииClosingBalance": "Edm.Double",
        },
        "output": {
            "Номенклатура_Key": "itemId",
            "Характеристика_Key": "variantId",
            "Склад_Key": "warehouseId",
            "ВНаличииOpeningBalance": "openingQuantity",
            "ВНаличииReceipt": "receivedQuantity",
            "ВНаличииExpense": "issuedQuantity",
            "ВНаличииClosingBalance": "closingQuantity",
        },
        "metrics": (
            "ВНаличииOpeningBalance",
            "ВНаличииReceipt",
            "ВНаличииExpense",
            "ВНаличииClosingBalance",
        ),
        "filters": {
            "warehouse": ("Склад_Key",),
            "item": ("Номенклатура_Key",),
        },
        "requiredAny": ("warehouse", "item"),
    },
}

GENERAL_ODATA_ENTITIES = frozenset(
    spec["entity"]
    for specs in (*GENERAL_REFERENCE_SPECS.values(), *GENERAL_DOCUMENT_SPECS.values())
    for spec in specs
) | frozenset(
    spec["entity"]
    for spec in GENERAL_FINANCIAL_RECORD_SPECS.values()
) | frozenset(
    spec["entity"]
    for spec in GENERAL_FINANCIAL_TURNOVER_SPECS.values()
    if spec.get("transport") == "record_table"
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
    # The complete fingerprint invalidates caches and other state when any
    # connection policy changes. Credentials use the narrower target
    # fingerprint below: pagination and timeouts cannot redirect a password,
    # whereas changing either allowed endpoint must require a fresh login.
    fingerprint: str
    credential_target_fingerprint: str
    legacy_credential_fingerprints: tuple[str, ...]


@dataclass(frozen=True)
class Credentials:
    username: str
    password: str


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
    credential_target_fingerprint = hashlib.sha256(
        _canonical_json(
            {
                "schemaVersion": 1,
                "odataBaseUrl": normalized_for_fingerprint["odataBaseUrl"],
                "filesBaseUrl": normalized_for_fingerprint["filesBaseUrl"],
            },
        ).encode("utf-8"),
    ).hexdigest()

    # Runtime <= 1.2.0 stored only the complete policy fingerprint beside
    # credentials.  Release 1.2.1 is published while the previous production
    # policy is known to be maxPages=3, then the company raises it to 10.  This
    # exact compatibility hash lets every user's untouched local session prove
    # that both endpoints and every other setting still match. It does not
    # accept a credential created for another URL and is removed naturally
    # once the local file is rewritten with credentialTargetFingerprint.
    legacy_configs = [normalized_for_fingerprint]
    if normalized_for_fingerprint["maxPages"] != 3:
        legacy_configs.append({**normalized_for_fingerprint, "maxPages": 3})
    legacy_credential_fingerprints = tuple(
        dict.fromkeys(
            hashlib.sha256(_canonical_json(item).encode("utf-8")).hexdigest()
            for item in legacy_configs
        ),
    )
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
        credential_target_fingerprint=credential_target_fingerprint,
        legacy_credential_fingerprints=legacy_credential_fingerprints,
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


def _local_state_matches_credential_target(
    value: Mapping[str, Any],
    config: CompanyConfig,
) -> tuple[bool, bool]:
    """Return whether local state is safe for this target and needs migration.

    New state binds directly to the endpoint-only fingerprint. Legacy state is
    accepted only when its full old policy hash is one of the exact compatible
    hashes constructed from the current endpoints and the former page limit.
    """

    target = value.get("credentialTargetFingerprint")
    if target is not None:
        return target == config.credential_target_fingerprint, False
    legacy_matches = value.get("fingerprint") in config.legacy_credential_fingerprints
    return legacy_matches, legacy_matches


def load_access_state(identity: Identity, config: CompanyConfig) -> dict[str, Any]:
    value = _read_private_json(access_state_path(identity))
    matches_target, needs_migration = (
        _local_state_matches_credential_target(value, config)
        if value
        else (False, False)
    )
    if not value or not matches_target:
        # A user choice of "no access" is meaningful only for the same fixed
        # credential destination. Changing either endpoint resets the decision
        # to unknown and prevents old credentials from being reused. Bounded
        # pagination and timeout changes deliberately do not force a login.
        return {
            "status": "unknown",
            "fingerprint": config.credential_target_fingerprint,
            "connectionChanged": bool(value),
        }
    status_value = value.get("status")
    if status_value not in ACCESS_STATES:
        raise OneCEdoError("invalid_local_state", "Локальный access status повреждён.")
    if status_value == "connected":
        credentials = _read_private_json(credentials_path(identity))
        credentials_match = (
            _local_state_matches_credential_target(credentials, config)[0]
            if credentials
            else False
        )
        if not credentials or not credentials_match:
            return {
                "status": "needs_reconnect",
                "fingerprint": config.credential_target_fingerprint,
                "connectionChanged": False,
            }
    if needs_migration:
        save_access_state(identity, config, str(status_value))
    return {
        "status": status_value,
        "fingerprint": config.credential_target_fingerprint,
        "connectionChanged": False,
    }


def save_access_state(identity: Identity, config: CompanyConfig, status_value: str) -> None:
    if status_value not in ACCESS_STATES:
        raise OneCEdoError("invalid_access_state", "Неподдерживаемый access status.")
    _write_private_json(
        access_state_path(identity),
        {
            "schemaVersion": 2,
            "fingerprint": config.fingerprint,
            "credentialTargetFingerprint": config.credential_target_fingerprint,
            "status": status_value,
            "updatedAt": _utc_now(),
        },
    )


def load_credentials(identity: Identity, config: CompanyConfig) -> Credentials:
    value = _read_private_json(credentials_path(identity))
    matches_target, needs_migration = (
        _local_state_matches_credential_target(value, config)
        if value
        else (False, False)
    )
    if not value or not matches_target:
        raise OneCEdoError(
            "credentials_missing",
            "Личные данные 1С не подключены для текущей company connection.",
        )
    username = value.get("username")
    password = value.get("password")
    if not isinstance(username, str) or not username or not isinstance(password, str) or not password:
        raise OneCEdoError("invalid_local_state", "Локальный credential-файл повреждён.")
    credentials = Credentials(username=username, password=password)
    if needs_migration:
        save_credentials(identity, config, credentials)
    return credentials


def save_credentials(
    identity: Identity,
    config: CompanyConfig,
    credentials: Credentials,
) -> None:
    _write_private_json(
        credentials_path(identity),
        {
            "schemaVersion": 2,
            "fingerprint": config.fingerprint,
            "credentialTargetFingerprint": config.credential_target_fingerprint,
            "username": credentials.username,
            "password": credentials.password,
            "updatedAt": _utc_now(),
        },
    )


def browser_prompt_app_page() -> bytes:
    """Render the self-contained local 1C credential page."""

    return """<!doctype html>
<html lang="ru">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trelio — 1С</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#eef0f2;
    color:#202124; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  main { width:min(560px,calc(100vw - 32px)); box-sizing:border-box; background:#fff;
    border:1px solid #d9dce1; border-radius:12px; box-shadow:0 18px 48px rgba(0,0,0,.18);
    padding:24px; }
  h1 { margin:0 0 12px; font-size:22px; line-height:1.35; font-weight:650; }
  form { display:grid; gap:14px; }
  input { box-sizing:border-box; width:100%; min-height:44px; border:2px solid #1a73e8;
    border-radius:8px; padding:8px 10px; color:#202124; background:#fff; font-size:18px; }
  input:focus { outline:3px solid rgba(26,115,232,.2); }
  .actions { display:flex; justify-content:flex-end; gap:10px; flex-wrap:wrap; }
  button { min-width:120px; min-height:40px; border:1px solid #c9cdd3; border-radius:8px;
    background:#eef0f2; color:#202124; font-size:16px; cursor:pointer; }
  button.primary { border-color:#1a73e8; background:#1a73e8; color:#fff; }
  .error { margin:0 0 12px; color:#b00020; font-size:14px; }
  .password-manager-warning { margin:0; padding:10px 12px; border-radius:8px;
    background:#fff8e1; color:#5f4200; font-size:14px; line-height:1.4; }
  .muted { margin:0; color:#5f6368; line-height:1.45; }
  .small { margin:12px 0 0; color:#5f6368; font-size:14px; line-height:1.4; }
</style>
<main id="app"><h1>Trelio — 1С</h1><p class="muted">Подготавливаю локальную форму…</p></main>
<script>
const app = document.getElementById("app");
let currentPromptId = null;
let polling = true;
function escapeHtml(value) {
  return String(value).replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
function renderWaiting() {
  currentPromptId = null;
  app.innerHTML = `<h1>Trelio — 1С</h1><p class="muted">Проверяю подключение…</p>`;
}
function renderFinished(data) {
  currentPromptId = null; polling = false;
  app.innerHTML = `<h1>${escapeHtml(data.title || "Готово")}</h1>
    <p class="muted">${escapeHtml(data.message || "Можно закрыть вкладку и вернуться в Codex.")}</p>`;
}
function renderPrompt(data) {
  currentPromptId = data.id;
  const inputType = data.hidden ? "password" : "text";
  const error = data.error ? `<p class="error">${escapeHtml(data.error)}</p>` : "";
  const maxLength = Number.isInteger(data.max_length) ? data.max_length : 2048;
  const passwordManagerWarning = data.hidden
    ? `<p class="password-manager-warning">Сохранять данные в браузере не нужно – подключение будет сохранено отдельно на этом устройстве. Если браузер предложит сохранить данные, выберите «Нет, спасибо».</p>`
    : "";
  app.innerHTML = `<h1>${escapeHtml(data.prompt)}</h1>${error}
    <form id="prompt-form" autocomplete="off">
      <input autofocus name="value" type="${inputType}" autocomplete="off"
        autocapitalize="none" spellcheck="false" maxlength="${escapeHtml(maxLength)}" required>
      ${passwordManagerWarning}
      <div class="actions"><button type="button" data-cancel="1">Отмена</button>
        <button class="primary" type="submit">Продолжить</button></div>
    </form>
    <p class="small">Данные остаются на этом компьютере и не отправляются в Trelio или чат.</p>`;
  const form = document.getElementById("prompt-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(form); formData.set("id", String(data.id));
    await submitPrompt(data, formData);
  });
  form.querySelector("[data-cancel]").addEventListener("click", async () => {
    const formData = new FormData(); formData.set("id", String(data.id));
    formData.set("cancel", "1"); await submitPrompt(data, formData);
  });
  form.querySelector("input").focus();
}
async function submitPrompt(data, formData) {
  const response = await fetch("submit", {method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},
    body:new URLSearchParams(formData), cache:"no-store"});
  const payload = await response.json();
  if (!payload.ok && payload.error) { data.error = payload.error; renderPrompt(data); return; }
  renderWaiting();
}
async function poll() {
  try {
    const response = await fetch("state?t=" + Date.now(), {cache:"no-store"});
    const data = await response.json();
    if (data.status === "prompt") {
      if (data.id !== currentPromptId) renderPrompt(data);
    } else if (data.status === "finished") { renderFinished(data); return; }
    else if (currentPromptId !== null) renderWaiting();
  } catch (_error) {
    polling = false;
    app.innerHTML = `<h1>Локальная страница закрыта</h1>
      <p class="muted">Вернитесь в Codex и при необходимости запустите подключение заново.</p>`;
  } finally { if (polling) setTimeout(poll, 350); }
}
poll();
</script>
""".encode("utf-8")


def open_browser_url(url: str) -> None:
    """Open one loopback URL without returning it in process output."""

    try:
        if sys.platform == "darwin":
            completed = subprocess.run(
                ["/usr/bin/open", url],
                check=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
            if completed.returncode != 0:
                raise OSError("default browser opener failed")
            return
        if sys.platform.startswith("win"):
            startfile = getattr(os, "startfile", None)
            if startfile is None:
                raise OSError("Windows shell opener is unavailable")
            startfile(url)
            return
        if not webbrowser.open(url, new=2):
            raise OSError("default browser opener failed")
    except (OSError, subprocess.TimeoutExpired, webbrowser.Error) as error:
        raise OneCEdoError(
            "protected_prompt_unavailable",
            "Не удалось открыть защищённую локальную страницу подключения 1С.",
        ) from error


class BrowserPromptSession:
    """Serve one tokenized loopback page for a single 1C connect process."""

    def __init__(self) -> None:
        self.token = secrets.token_urlsafe(32)
        self.condition = threading.Condition()
        self.page_loaded = threading.Event()
        self.finished_seen = threading.Event()
        self.current_prompt: dict[str, Any] | None = None
        self.response: dict[str, Any] | None = None
        self.finished: dict[str, str] | None = None
        self.next_prompt_id = 0
        self.opened = False
        try:
            self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), self._handler_class())
        except OSError as error:
            raise OneCEdoError(
                "protected_prompt_unavailable",
                "Защищённая страница подключения 1С не может занять локальный порт.",
            ) from error
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def port(self) -> int:
        return int(self.server.server_address[1])

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def base_path(self) -> str:
        return f"/{self.token}"

    @property
    def url(self) -> str:
        return f"{self.origin}{self.base_path}/"

    def _handler_class(self) -> Any:
        session = self

        class PromptHandler(http.server.BaseHTTPRequestHandler):
            server_version = "TrelioLoopback/1"
            sys_version = ""

            def log_message(self, _format: str, *_args: Any) -> None:
                return

            def end_headers(self) -> None:
                for name, value in (
                    ("Cache-Control", "no-store"),
                    ("Pragma", "no-cache"),
                    ("Referrer-Policy", "no-referrer"),
                    ("X-Content-Type-Options", "nosniff"),
                    ("X-Frame-Options", "DENY"),
                    ("Cross-Origin-Resource-Policy", "same-origin"),
                    (
                        "Content-Security-Policy",
                        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
                        "connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
                    ),
                ):
                    self.send_header(name, value)
                super().end_headers()

            def send_bytes(self, body: bytes, content_type: str, status: int = 200) -> None:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)
                self.close_connection = True

            def send_json(self, payload: dict[str, Any], status: int = 200) -> None:
                self.send_bytes(
                    json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                    "application/json; charset=utf-8",
                    status,
                )

            def request_is_local(self) -> bool:
                return (
                    self.client_address[0] == "127.0.0.1"
                    and self.headers.get("Host") == f"127.0.0.1:{session.port}"
                )

            def prompt_subpath(self) -> str | None:
                path = urllib.parse.urlparse(self.path).path
                if path == session.base_path:
                    return "/"
                prefix = session.base_path + "/"
                return "/" + path[len(prefix):] if path.startswith(prefix) else None

            def do_GET(self) -> None:  # noqa: N802
                if not self.request_is_local():
                    self.send_json({"ok": False, "error": "Forbidden."}, status=403)
                    return
                subpath = self.prompt_subpath()
                if subpath == "/":
                    session.page_loaded.set()
                    self.send_bytes(browser_prompt_app_page(), "text/html; charset=utf-8")
                    return
                if subpath == "/state":
                    with session.condition:
                        finished = dict(session.finished) if session.finished else None
                        prompt = dict(session.current_prompt) if session.current_prompt else None
                    if finished:
                        self.send_json({"status": "finished", **finished})
                        session.finished_seen.set()
                    elif prompt:
                        self.send_json({"status": "prompt", **prompt})
                    else:
                        self.send_json({"status": "waiting"})
                    return
                self.send_json({"ok": False, "error": "Not found."}, status=404)

            def do_POST(self) -> None:  # noqa: N802
                if not self.request_is_local() or self.prompt_subpath() != "/submit":
                    self.send_json({"ok": False, "error": "Forbidden."}, status=403)
                    return
                if self.headers.get("Origin") != session.origin:
                    self.send_json({"ok": False, "error": "Forbidden."}, status=403)
                    return
                content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                if content_type != "application/x-www-form-urlencoded":
                    self.send_json({"ok": False, "error": "Unsupported request."}, status=415)
                    return
                try:
                    length = int(self.headers.get("Content-Length", ""))
                except ValueError:
                    length = -1
                if length < 0 or length > MAX_PROMPT_BODY_BYTES:
                    self.send_json({"ok": False, "error": "Invalid request size."}, status=413)
                    return
                try:
                    fields = urllib.parse.parse_qs(
                        self.rfile.read(length).decode("utf-8", errors="strict"),
                        keep_blank_values=True,
                        max_num_fields=4,
                    )
                    prompt_id = int((fields.get("id") or [""])[0])
                except (UnicodeError, ValueError):
                    self.send_json({"ok": False, "error": "Invalid request body."}, status=400)
                    return
                with session.condition:
                    prompt = session.current_prompt
                    if not prompt or prompt["id"] != prompt_id:
                        self.send_json({"ok": False, "error": "Этот шаг уже не актуален."}, status=409)
                        return
                    if fields.get("cancel"):
                        session.response = {"cancelled": True}
                    else:
                        value = (fields.get("value") or [""])[0]
                        if prompt.get("trim"):
                            value = value.strip()
                        if not value:
                            self.send_json({"ok": False, "error": "Нужно заполнить поле."}, status=400)
                            return
                        if len(value) > int(prompt["max_length"]):
                            self.send_json({"ok": False, "error": "Значение слишком длинное."}, status=400)
                            return
                        session.response = {"cancelled": False, "value": value}
                    session.current_prompt = None
                    session.condition.notify_all()
                self.send_json({"ok": True})

        return PromptHandler

    def open(self) -> None:
        if self.opened:
            return
        self.page_loaded.clear()
        open_browser_url(self.url)
        if not self.page_loaded.wait(timeout=BROWSER_LOAD_TIMEOUT_SECONDS):
            raise OneCEdoError(
                "protected_prompt_unavailable",
                "Браузер не загрузил защищённую локальную страницу подключения 1С.",
            )
        self.opened = True

    def ask(self, prompt: str, *, hidden: bool, trim: bool, max_length: int) -> str:
        with self.condition:
            self.next_prompt_id += 1
            self.response = None
            self.finished = None
            self.finished_seen.clear()
            self.current_prompt = {
                "id": self.next_prompt_id,
                "prompt": prompt,
                "hidden": hidden,
                "trim": trim,
                "max_length": max_length,
                "error": "",
            }
            self.condition.notify_all()
        try:
            self.open()
        except OneCEdoError:
            with self.condition:
                self.current_prompt = None
            raise
        deadline = time.monotonic() + BROWSER_INPUT_TIMEOUT_SECONDS
        with self.condition:
            while self.response is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self.current_prompt = None
                    raise OneCEdoError(
                        "protected_prompt_timeout",
                        "Время ввода данных 1С истекло. Запустите connect заново.",
                    )
                self.condition.wait(timeout=remaining)
            response = self.response
            self.response = None
        if response.get("cancelled"):
            raise OneCEdoError("connect_cancelled", "Подключение отменено пользователем.")
        return str(response.get("value") or "")

    def finish(self, *, title: str, message: str) -> None:
        with self.condition:
            self.current_prompt = None
            self.response = None
            self.finished = {"title": title, "message": message}
            self.finished_seen.clear()
            self.condition.notify_all()
        if self.opened:
            self.finished_seen.wait(timeout=1)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


BROWSER_PROMPT_SESSION: BrowserPromptSession | None = None


def ensure_browser_prompt_session() -> BrowserPromptSession:
    global BROWSER_PROMPT_SESSION
    if BROWSER_PROMPT_SESSION is None:
        BROWSER_PROMPT_SESSION = BrowserPromptSession()
    return BROWSER_PROMPT_SESSION


def shutdown_browser_prompt_session() -> None:
    global BROWSER_PROMPT_SESSION
    if BROWSER_PROMPT_SESSION is None:
        return
    BROWSER_PROMPT_SESSION.close()
    BROWSER_PROMPT_SESSION = None


def _prompt_credentials_terminal() -> Credentials:
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        raise OneCEdoError(
            "protected_prompt_unavailable",
            "Для --terminal-prompts нужен видимый локальный интерактивный терминал.",
        )
    username = input("Логин 1С: ").strip()
    password = getpass.getpass("Пароль 1С: ")
    if not username or not password:
        raise OneCEdoError("credentials_empty", "Логин и пароль 1С не могут быть пустыми.")
    return Credentials(username=username, password=password)


def _prompt_credentials_browser() -> Credentials:
    session = ensure_browser_prompt_session()
    username = session.ask(
        "Введите личный логин 1С",
        hidden=False,
        trim=True,
        max_length=MAX_USERNAME_CHARS,
    )
    password = session.ask(
        "Введите личный пароль 1С",
        hidden=True,
        trim=False,
        max_length=MAX_PASSWORD_CHARS,
    )
    return Credentials(username=username, password=password)


def prompt_credentials(args: argparse.Namespace) -> Credentials:
    if bool(getattr(args, "terminal_prompts", False)):
        return _prompt_credentials_terminal()
    return _prompt_credentials_browser()


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


def _retry_after_delay_seconds(
    raw_value: str | None,
    *,
    now_seconds: float | None = None,
) -> float | None:
    """Parse RFC Retry-After without accepting an unbounded wait request."""

    value = str(raw_value or "").strip()
    if not value or len(value) > MAX_RETRY_AFTER_HEADER_CHARS:
        return None
    if re.fullmatch(r"\d+", value):
        return float(int(value))
    try:
        parsed = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    current_seconds = time.time() if now_seconds is None else now_seconds
    return max(0.0, parsed.timestamp() - current_seconds)


def _rate_limit_retry_delay_seconds(
    error: urllib.error.HTTPError,
    retry_count: int,
) -> float:
    headers = error.headers
    raw_retry_after = None
    if headers is not None:
        raw_retry_after = headers.get("Retry-After") or headers.get("retry-after")
    retry_after = _retry_after_delay_seconds(raw_retry_after)
    if retry_after is not None:
        return retry_after
    fallback = min(
        FALLBACK_RATE_LIMIT_DELAY_SECONDS * (2 ** retry_count),
        MAX_FALLBACK_RATE_LIMIT_DELAY_SECONDS,
    )
    return fallback + secrets.randbelow(RATE_LIMIT_JITTER_MILLISECONDS + 1) / 1_000


def _close_http_error(error: urllib.error.HTTPError) -> None:
    # Some Python/urllib adapters expose an HTTPError without a readable body.
    # Cleanup must never replace the original bounded status/error semantics.
    with contextlib.suppress(Exception):
        error.close()


def _open_with_rate_limit_retry(
    opener: Any,
    request: urllib.request.Request,
    *,
    timeout: float,
) -> Any:
    retry_count = 0
    total_retry_wait = 0.0
    while True:
        try:
            return opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            if error.code != 429 or retry_count >= MAX_RATE_LIMIT_RETRIES:
                raise
            delay_seconds = _rate_limit_retry_delay_seconds(error, retry_count)
            if (
                delay_seconds > MAX_RATE_LIMIT_WAIT_SECONDS
                or total_retry_wait + delay_seconds
                > MAX_RATE_LIMIT_TOTAL_WAIT_SECONDS
            ):
                raise
            # HTTPError owns the rejected response body/socket. Close it before
            # sleeping so a bounded retry cannot leak connections.
            _close_http_error(error)
            retry_count += 1
            total_retry_wait += delay_seconds
            time.sleep(delay_seconds)


def _http_open(
    method: str,
    url: str,
    *,
    credentials: Credentials,
    timeout: float,
    x_odata: str | None,
    diagnostic_stage: str,
    accept: str | None = None,
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
    request = urllib.request.Request(url, headers=headers, method=method)
    opener = urllib.request.build_opener(
        NoRedirectHandler(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
    )
    try:
        return _open_with_rate_limit_retry(opener, request, timeout=timeout)
    except urllib.error.HTTPError as error:
        _close_http_error(error)
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
        if diagnostic_stage.startswith("general.") and error.code in {400, 404}:
            raise OneCEdoError(
                "source_contract_mismatch",
                "Фиксированный источник 1С больше не соответствует подписанному registry.",
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
        raise OneCEdoError(
            "source_contract_mismatch",
            "1С вернула ответ, не соответствующий подписанному source contract.",
        ) from error
    if not isinstance(value, dict):
        raise OneCEdoError(
            "source_contract_mismatch",
            "1С вернула ответ, не соответствующий подписанному source contract.",
        )
    return value


def _odata_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Require one exact OData collection shape and reject partial rows."""

    raw_rows = payload.get("value")
    if raw_rows is None and isinstance(payload.get("d"), dict):
        raw_rows = payload["d"].get("results")
    if not isinstance(raw_rows, list):
        raise OneCEdoError(
            "source_contract_mismatch",
            "1С вернула ответ, не соответствующий подписанному source contract.",
        )
    if any(not isinstance(row, dict) for row in raw_rows):
        raise OneCEdoError(
            "source_contract_mismatch",
            "1С вернула строки, не соответствующие подписанному source contract.",
        )
    return list(raw_rows)


def _general_value_matches_edm(value: Any, expected_type: str) -> bool:
    """Validate JSON scalar/collection shapes frozen by the signed registry."""

    if value is None:
        # The reviewed fields are nullable at the transport boundary. Semantic
        # requirements such as a non-null Ref_Key are checked by normalizers.
        return True
    if expected_type == "Edm.Guid":
        return isinstance(value, str) and (
            value == ZERO_UUID or bool(UUID_RE.fullmatch(value))
        )
    if expected_type == "Edm.String":
        return isinstance(value, str)
    if expected_type == "Edm.Boolean":
        return isinstance(value, bool)
    if expected_type == "Edm.DateTime":
        if not isinstance(value, str):
            return False
        try:
            dt.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return False
        return True
    if expected_type == "Edm.Double":
        return (
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and (not isinstance(value, float) or math.isfinite(value))
        )
    if expected_type == "Edm.Int64":
        return (
            isinstance(value, int)
            and not isinstance(value, bool)
        ) or (
            isinstance(value, str)
            and len(value) <= 20
            and bool(re.fullmatch(r"-?(?:0|[1-9][0-9]*)", value))
        )
    if expected_type.startswith("Collection(") and expected_type.endswith(")"):
        return isinstance(value, list)
    return False


def _validate_general_source_record(
    value: Any,
    field_types: Mapping[str, str],
    *,
    selected_fields: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Fail closed when a fixed source omits or changes a selected field."""

    if not isinstance(value, dict):
        raise OneCEdoError(
            "source_contract_mismatch",
            "1С вернула запись, не соответствующую подписанному source contract.",
        )
    selected = tuple(selected_fields or field_types)
    if (
        any(field not in field_types for field in selected)
        or any(field not in value for field in selected)
        or any(
            not _general_value_matches_edm(value[field], field_types[field])
            for field in selected
        )
    ):
        raise OneCEdoError(
            "capability_schema_changed",
            "Фиксированный источник 1С больше не соответствует подписанному registry.",
        )
    return value


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


def _probe_personal_connection(
    config: CompanyConfig,
    credentials: Credentials,
    *,
    diagnostic_stage: str,
) -> None:
    """Probe one fixed broad-registry source without entering the EDO contour."""

    source = GENERAL_REFERENCE_SPECS["organization"][0]
    first_field = next(iter(source["fields"]))
    _request_odata(
        config,
        credentials,
        source["entity"],
        (
            ("$select", first_field),
            ("$top", 1),
        ),
        diagnostic_stage=diagnostic_stage,
    )


def command_connect(args: argparse.Namespace) -> dict[str, Any]:
    identity = load_identity()
    config = load_company_config()
    credentials = prompt_credentials(args)
    try:
        _probe_personal_connection(
            config,
            credentials,
            diagnostic_stage="connect.probe",
        )
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    # Network failures intentionally preserve the previous state and do not
    # destroy working credentials or invent either no_access/needs_reconnect.
    save_credentials(identity, config, credentials)
    save_access_state(identity, config, "connected")
    if BROWSER_PROMPT_SESSION is not None:
        BROWSER_PROMPT_SESSION.finish(
            title="1С подключена",
            message="Личные данные проверены и сохранены только на этом компьютере.",
        )
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
            _probe_personal_connection(
                config,
                credentials,
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
    save_access_state(identity, config, "unknown")
    return {"status": "unknown", "credentialsRemoved": removed}


def _general_registry_material(section: str, kind: str) -> dict[str, Any]:
    """Return the private canonical material used for one capability digest.

    The digest is agent-visible, but this material is not.  In particular,
    ordinary production results never expose internal 1C field names.
    """

    registries: dict[str, Mapping[str, Any]] = {
        "reference": GENERAL_REFERENCE_SPECS,
        "document": GENERAL_DOCUMENT_SPECS,
        "financial_turnover": GENERAL_FINANCIAL_TURNOVER_SPECS,
        "financial_record": GENERAL_FINANCIAL_RECORD_SPECS,
        "balance": GENERAL_BALANCE_SPECS,
    }
    source = registries.get(section)
    specs = source.get(kind) if source is not None else None
    if specs is None:
        raise OneCEdoError(
            "capability_blocked",
            "Запрошенная capability не входит в фиксированный registry.",
        )
    normalized_specs = specs if isinstance(specs, tuple) else (specs,)
    return {
        "registryVersion": GENERAL_REGISTRY_VERSION,
        "section": section,
        "kind": kind,
        "sources": [
            {
                "entity": spec["entity"],
                "sourceType": spec["sourceType"],
                "function": spec.get("function"),
                "dimensions": list(spec.get("dimensions", ())),
                "fields": dict(sorted(spec["fields"].items())),
                "lineFields": dict(sorted(spec.get("lineFields", {}).items())),
                "output": dict(sorted(spec.get("output", {}).items())),
                "metrics": list(spec.get("metrics", ())),
                "filters": (
                    {
                        name: list(fields)
                        for name, fields in sorted(spec.get("filters", {}).items())
                    }
                    if isinstance(spec.get("filters"), dict)
                    else list(spec.get("filters", ()))
                ),
                "filterSourceTypes": dict(
                    sorted(spec.get("filterSourceTypes", {}).items()),
                ),
                "filterTypes": dict(
                    sorted(spec.get("filterTypes", {}).items()),
                ),
                "requiredAny": list(spec.get("requiredAny", ())),
                "dateField": spec.get("dateField"),
                "stateClauses": list(spec.get("stateClauses", ())),
            }
            for spec in normalized_specs
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
    """Digest the complete company-specific registry embedded in the package."""

    material = {
        "capabilities": [
            _general_registry_material(section, kind)
            for section, registry in (
                ("reference", GENERAL_REFERENCE_SPECS),
                ("document", GENERAL_DOCUMENT_SPECS),
                ("financial_turnover", GENERAL_FINANCIAL_TURNOVER_SPECS),
                ("financial_record", GENERAL_FINANCIAL_RECORD_SPECS),
                ("balance", GENERAL_BALANCE_SPECS),
            )
            for kind in registry
        ],
        "links": {
            "edoEntities": dict(sorted(DOCUMENT_ENTITIES.items())),
            "edoFields": dict(sorted(GENERAL_EDO_LINK_FIELDS.items())),
        },
    }
    raw = _canonical_json(material).encode("utf-8")
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


def _general_signed_contract(
    capabilities: Iterable[tuple[str, str]],
) -> dict[str, Any]:
    """Return the static release contract without performing any I/O.

    The signed package itself is the authority for the Vkus entity/field
    profile. Production requests therefore go straight to a fixed source and
    validate its actual JSON response. The development inventory digest is
    provenance only; no metadata route exists in this executable.
    """

    capability_digests: dict[str, str] = {}
    for section, kind in capabilities:
        key = f"{section}.{kind}"
        capability_digests[key] = _general_capability_digest(section, kind)
    return {
        "profileSchemaDigest": GENERAL_PROFILE_SCHEMA_DIGEST,
        "registryDigest": _general_registry_digest(),
        "capabilityDigests": capability_digests,
        "validation": {
            "mode": "signed_registry_response_contract",
            "metadataRequest": False,
            "registrySource": "signed_package",
            "responseValidation": "fail_closed",
        },
    }


def _general_uuid_value(value: Any, field_label: str) -> str | None:
    """Normalize a 1C reference, treating its all-zero sentinel as absent."""

    if value in {None, "", ZERO_UUID}:
        return None
    if not isinstance(value, str) or not UUID_RE.fullmatch(value):
        raise OneCEdoError(
            "capability_schema_changed",
            f"Фиксированный источник 1С вернул некорректный {field_label}.",
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
    _validate_general_source_record(raw, spec["fields"])
    safe = _safe_selected_record(raw, spec["fields"])
    reference = _general_uuid_value(safe.get("Ref_Key"), "reference id")
    if reference is None:
        raise OneCEdoError(
            "capability_schema_changed",
            "Фиксированный справочник 1С вернул пустой идентификатор.",
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
        "unitSymbol": _general_text(safe.get("МеждународноеСокращение")),
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
        "accountType": _general_text(safe.get("Type")),
        "offBalance": _normalized_boolean(safe.get("OffBalance")),
        "tracksBusinessUnits": _normalized_boolean(
            safe.get("УчетПоПодразделениям"),
        ),
        "tracksBusinessDirections": _normalized_boolean(
            safe.get("УчетПоНаправлениямДеятельности"),
        ),
        "taxAccounting": _normalized_boolean(safe.get("НалоговыйУчет")),
        "cashFlowType": _general_text(
            safe.get("ВидДвиженияДенежныхСредств"),
        ),
        "allocationPurpose": _general_text(safe.get("НазначениеПравила")),
        "allocationBase": _general_text(safe.get("БазаРаспределения")),
        "allocationDisplay": _general_text(safe.get("ПредставлениеПравила")),
        "allocateToItems": _normalized_boolean(
            safe.get("РаспределятьНаСтатьи"),
        ),
        "allocateByBusinessUnit": _normalized_boolean(
            safe.get("РаспределятьПоПодразделениям"),
        ),
        "businessUnitsManual": _normalized_boolean(
            safe.get("ПодразделенияУказаныВручную"),
        ),
        "obsolete": _normalized_boolean(safe.get("Устаревшее")),
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
    # Capabilities are a signed, release-time fact. Loading the normalized
    # company limits is local-only and this command performs no credential,
    # secret or network operation.
    config = load_company_config()
    all_capabilities = [
        *(("reference", kind) for kind in GENERAL_REFERENCE_SPECS),
        *(("document", kind) for kind in GENERAL_DOCUMENT_SPECS),
        *(
            ("financial_turnover", kind)
            for kind in GENERAL_FINANCIAL_TURNOVER_SPECS
        ),
        *(
            ("financial_record", kind)
            for kind in GENERAL_FINANCIAL_RECORD_SPECS
        ),
        *(("balance", kind) for kind in GENERAL_BALANCE_SPECS),
    ]
    schema = _general_signed_contract(all_capabilities)
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
    financial_turnovers = [
        {
            "kind": kind,
            "status": "supported",
            "type": spec["sourceType"],
            "filters": list(spec["filters"]),
            "filterSourceTypes": dict(spec.get("filterSourceTypes", {})),
            "periodRequired": True,
            "sensitiveConfirmationRequired": True,
            "capabilityDigest": schema["capabilityDigests"][
                f"financial_turnover.{kind}"
            ],
        }
        for kind, spec in GENERAL_FINANCIAL_TURNOVER_SPECS.items()
    ]
    financial_records = [
        {
            "kind": kind,
            "status": "supported",
            "type": spec["sourceType"],
            "filters": list(spec["filters"]),
            "filterSourceTypes": dict(spec.get("filterSourceTypes", {})),
            "periodRequired": True,
            "sensitiveConfirmationRequired": True,
            "capabilityDigest": schema["capabilityDigests"][
                f"financial_record.{kind}"
            ],
        }
        for kind, spec in GENERAL_FINANCIAL_RECORD_SPECS.items()
    ]
    balances = [
        {
            "kind": kind,
            "status": "supported",
            "type": spec["sourceType"],
            "filters": list(spec["filters"]),
            "filterSourceTypes": dict(spec.get("filterSourceTypes", {})),
            "periodRequired": True,
            "sensitiveConfirmationRequired": True,
            "capabilityDigest": schema["capabilityDigests"][
                f"balance.{kind}"
            ],
        }
        for kind, spec in GENERAL_BALANCE_SPECS.items()
    ]
    return {
        "registryVersion": GENERAL_REGISTRY_VERSION,
        "schema": schema,
        "sections": {
            "references": references,
            "documents": documents,
            "financialTurnovers": financial_turnovers,
            "financialRecords": financial_records,
            "balances": balances,
            "budgetDrilldowns": [
                {
                    "kind": "budget",
                    "status": "supported",
                    "filters": ["period", "business_unit", "budget_item"],
                    "registrarTypes": [
                        "internal_consumption",
                        "purchase",
                        "service_purchase",
                        "expense_report",
                    ],
                    "controlRegistrarTypes": ["expense_distribution"],
                    "coverage": "fail_closed_all_active_registrars",
                    "sensitiveConfirmationRequired": True,
                    "capabilityDigest": schema["capabilityDigests"][
                        "financial_turnover.budget"
                    ],
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
            "maxFinancialPageSize": min(
                config.max_rows,
                GENERAL_MAX_FINANCIAL_PAGE_SIZE,
            ),
            "maxPages": min(config.max_pages, GENERAL_MAX_PAGES),
            "maxLines": GENERAL_MAX_LINES,
            "maxFinancialPeriodDays": GENERAL_MAX_FINANCIAL_PERIOD_DAYS,
            "requestTimeoutSeconds": config.request_timeout_seconds,
            "responseBytes": MAX_ODATA_RESPONSE_BYTES,
        },
        "reporting": {
            "pnlAssembly": False,
            "sourceDataOnly": True,
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
    schema = _general_signed_contract((("reference", kind),))
    try:
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
                    "source_contract_mismatch",
                    "1С вернула постороннюю запись для exact reference id.",
                )
            result.append(normalized)
    return result


def _general_reference_map_by_ids(
    config: CompanyConfig,
    credentials: Credentials,
    kind: str,
    references: Iterable[str | None],
) -> dict[str, dict[str, Any]]:
    """Resolve a bounded UUID set through one fixed catalog profile.

    Document enrichment can contain up to ``GENERAL_MAX_LINES`` goods rows.
    Querying one catalog row at a time would be unnecessarily expensive, so
    the runtime builds small OR groups from already validated UUID literals.
    The entity, selected fields and operators remain fixed by the registry.
    """

    normalized = sorted(
        {
            _uuid(reference, f"{kind} reference id")
            for reference in references
            if reference
        },
    )
    if len(normalized) > GENERAL_MAX_LINES:
        raise OneCEdoError(
            "source_contract_mismatch",
            "Документ содержит слишком много уникальных ссылок для enrichment.",
        )
    specs = GENERAL_REFERENCE_SPECS[kind]
    if len(specs) != 1:
        raise OneCEdoError(
            "query_builder_error",
            "Batch enrichment разрешён только для однозначного справочника.",
        )
    spec = specs[0]
    result: dict[str, dict[str, Any]] = {}
    # Twenty UUID clauses keep every fixed GET comfortably below ordinary URL
    # limits while bounding the number of requests to five for a 100-line doc.
    for offset in range(0, len(normalized), 20):
        chunk = normalized[offset : offset + 20]
        clauses = " or ".join(
            f"Ref_Key eq guid'{reference}'"
            for reference in chunk
        )
        rows = _odata_rows(
            _request_odata(
                config,
                credentials,
                spec["entity"],
                (
                    ("$select", _selected_fields(spec["fields"])),
                    ("$filter", f"({clauses})"),
                    ("$top", len(chunk) + 1),
                ),
                diagnostic_stage=f"general.reference.{kind}.get",
            ),
        )
        if len(rows) > len(chunk):
            raise OneCEdoError(
                "source_contract_mismatch",
                "1С вернула лишние записи для фиксированного набора UUID.",
            )
        expected = frozenset(chunk)
        for row in rows:
            item = _general_reference_record(
                kind,
                spec,
                row,
                matched_by=["id"],
            )
            reference = str(item["id"])
            if reference not in expected or reference in result:
                raise OneCEdoError(
                    "source_contract_mismatch",
                    "1С вернула постороннюю или повторную reference-запись.",
                )
            result[reference] = item
    return result


def command_general_get_reference_item(args: argparse.Namespace) -> dict[str, Any]:
    identity, config, credentials = _connected_context()
    kind = str(args.kind)
    reference = _uuid(args.id, "reference id")
    schema = _general_signed_contract((("reference", kind),))
    try:
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
            "source_contract_mismatch",
            "1С вернула неоднозначный результат для фиксированного справочника.",
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
    line_collection = str(spec.get("lineCollection") or "Товары")
    selected_fields = tuple(
        field
        for field in spec["fields"]
        if include_lines or field != line_collection
    )
    _validate_general_source_record(
        raw,
        spec["fields"],
        selected_fields=selected_fields,
    )
    safe = _safe_selected_record(raw, selected_fields)
    reference = _general_uuid_value(safe.get("Ref_Key"), "document id")
    if reference is None:
        raise OneCEdoError(
            "capability_schema_changed",
            "Фиксированный документ 1С вернул пустой идентификатор.",
        )
    source_type = str(spec["sourceType"])
    raw_lines = raw.get(line_collection) if include_lines else []
    if raw_lines is None:
        raw_lines = []
    if not isinstance(raw_lines, list):
        raise OneCEdoError(
            "capability_schema_changed",
            "Фиксированный документ 1С вернул строки неожиданного типа.",
        )
    normalized_lines: list[dict[str, Any]] = []
    for raw_line in raw_lines[:line_limit]:
        _validate_general_source_record(raw_line, spec["lineFields"])
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
            "amountWithVat": _general_number(line.get("СуммаСНДС")),
            "unitId": _general_uuid_value(
                line.get("Упаковка_Key"),
                "line unit id",
            ),
            "expenseItemReference": _general_text(
                line.get("СтатьяРасходов"),
            ),
            "expenseItemType": _general_text(
                line.get("СтатьяРасходов_Type"),
            ),
            "expenseItemId": _general_uuid_value(
                line.get("СтатьяРасходов_Key"),
                "line expense item id",
            ),
            "writeOffToExpenses": _normalized_boolean(
                line.get("СписатьНаРасходы"),
            ),
            "content": _general_text(line.get("Содержание")),
            "comment": _general_text(line.get("Комментарий")),
            "allocationComment": _general_text(
                line.get("КомментарийРаспределения"),
            ),
            "sourceLineId": _general_text(
                line.get("ИдентификаторСтроки"),
            ),
            "sourceDocumentName": _general_text(
                line.get("НаименованиеВходящегоДокумента"),
            ),
            "sourceDocumentNumber": _general_text(
                line.get("НомерВходящегоДокумента"),
            ),
            "sourceDocumentDate": _normalized_1c_datetime(
                line.get("ДатаВходящегоДокумента"),
                field_label="source document date",
            ),
            "counterpartyId": _general_uuid_value(
                line.get("Контрагент_Key"),
                "line counterparty id",
            ),
            "isCancelled": _normalized_boolean(line.get("Отменено")),
            "cancellationReason": _general_text(line.get("ПричинаОтмены")),
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
        "amount": _general_number(
            safe.get(str(spec.get("amountField") or "СуммаДокумента")),
        ),
        "comment": _general_text(safe.get("Комментарий")),
        "advancePurpose": _general_text(safe.get("НазначениеАванса")),
        "approvedAt": _normalized_1c_datetime(
            safe.get("ДатаУтверждения"),
            field_label="approval date",
        ),
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
    line_collection = str(spec.get("lineCollection") or "Товары")
    fields = [
        field
        for field in spec["fields"]
        if include_lines or field != line_collection
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
    schema = _general_signed_contract((("document", kind),))
    try:
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
                    "source_contract_mismatch",
                    "1С вернула постороннюю запись для exact document id.",
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
    schema = _general_signed_contract((("document", kind),))
    try:
        matches = _general_documents_by_id(
            config,
            credentials,
            kind,
            reference,
            include_lines=bool(args.include_lines),
            line_limit=line_limit,
        )
        if (
            kind == "internal_consumption"
            and bool(args.include_lines)
            and len(matches) == 1
        ):
            matches[0] = _general_enrich_internal_consumption_document(
                config,
                credentials,
                matches[0],
            )
        if bool(args.include_lines) and len(matches) == 1:
            matches[0] = _general_enrich_document_line_references(
                config,
                credentials,
                matches[0],
            )
        save_access_state(identity, config, "connected")
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    if len(matches) > 1:
        raise OneCEdoError(
            "source_contract_mismatch",
            "1С вернула неоднозначный результат для фиксированного документа.",
        )
    return {
        "kind": kind,
        "document": matches[0] if matches else None,
        "matchedBy": ["id"],
        "schema": schema,
        "limits": {"maxLines": GENERAL_MAX_LINES},
    }


def _general_require_sensitive(args: argparse.Namespace) -> None:
    """Require an explicit per-command basis before returning finance data.

    The flag is intentionally not persisted. A later agent may have a
    different task and must independently establish that reading financial or
    payroll aggregates is necessary for the user's request.
    """

    if not bool(getattr(args, "include_sensitive", False)):
        raise OneCEdoError(
            "sensitive_data_confirmation_required",
            "Для финансовых данных нужен явный --include-sensitive в рамках текущей задачи.",
        )


def _general_financial_period(args: argparse.Namespace) -> tuple[dt.date, dt.date]:
    """Return inclusive start and exclusive end for a bounded finance period."""

    date_from = _general_parse_date(args.date_from, "date-from")
    date_to = _general_parse_date(args.date_to, "date-to")
    if date_from is None or date_to is None:
        raise OneCEdoError(
            "period_required",
            "Для финансовых данных обязательны date-from и date-to.",
        )
    if date_from > date_to:
        raise OneCEdoError(
            "invalid_period",
            "date-from не может быть позже date-to.",
        )
    if (date_to - date_from).days + 1 > GENERAL_MAX_FINANCIAL_PERIOD_DAYS:
        raise OneCEdoError(
            "period_too_large",
            (
                "Период финансового запроса не может превышать "
                f"{GENERAL_MAX_FINANCIAL_PERIOD_DAYS} календарных дней."
            ),
        )
    return date_from, date_to + dt.timedelta(days=1)


def _general_financial_page(
    args: argparse.Namespace,
    config: CompanyConfig,
) -> tuple[int, int]:
    """Validate finance pagination against both company and package limits."""

    page = int(args.page)
    limit = int(args.limit)
    max_pages = min(config.max_pages, GENERAL_MAX_PAGES)
    max_limit = min(config.max_rows, GENERAL_MAX_FINANCIAL_PAGE_SIZE)
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


def _general_financial_filter(
    args: argparse.Namespace,
    spec: Mapping[str, Any],
) -> tuple[str, list[str]]:
    """Build one fixed UUID-only scope filter for a finance source.

    A caller can choose values but cannot introduce a field, operator or OData
    fragment. Multi-field concepts such as debit/credit account are expanded
    from the signed registry and joined with OR inside one bounded clause.
    """

    requested = {
        "organization": str(getattr(args, "organization_id", "") or ""),
        "business_unit": str(getattr(args, "business_unit_id", "") or ""),
        "account": str(getattr(args, "account_id", "") or ""),
        "warehouse": str(getattr(args, "warehouse_id", "") or ""),
        "item": str(getattr(args, "item_id", "") or ""),
        "budget_item": str(getattr(args, "budget_item_id", "") or ""),
    }
    supported_filters = spec.get("filters", {})
    unsupported = [
        name
        for name, value in requested.items()
        if value and name not in supported_filters
    ]
    if unsupported:
        raise OneCEdoError(
            "filter_unsupported",
            f"Фильтр {unsupported[0]} не поддержан для этого финансового источника.",
        )
    required_any = tuple(spec.get("requiredAny", ()))
    if required_any and not any(requested.get(name) for name in required_any):
        public_labels = {
            "organization": "organization-id",
            "business_unit": "business-unit-id",
            "account": "account-id",
            "warehouse": "warehouse-id",
            "item": "item-id",
            "budget_item": "budget-item-id",
        }
        choices = ", ".join(public_labels[name] for name in required_any)
        raise OneCEdoError(
            "scope_filter_required",
            f"Нужен хотя бы один ограничивающий фильтр: {choices}.",
        )

    clauses: list[str] = []
    matched: list[str] = []
    for name, raw_value in requested.items():
        if not raw_value:
            continue
        fields = tuple(supported_filters[name])
        reference = _uuid(raw_value, f"{name} id")
        expected_type = str(spec.get("filterTypes", {}).get(name, "Edm.Guid"))
        if expected_type == "Edm.Guid":
            literal = f"guid'{reference}'"
        else:
            # A registry edit cannot silently introduce a caller-controlled
            # literal type.  New scalar types require an explicit reviewed
            # branch and release-time tests here.
            raise OneCEdoError(
                "query_builder_error",
                "Подписанный finance registry содержит неподдержанный filter type.",
            )
        alternatives = " or ".join(
            f"{field} eq {literal}"
            for field in fields
        )
        clauses.append(f"({alternatives})")
        matched.append(name)
    return " and ".join(clauses), matched


def _general_virtual_url(
    config: CompanyConfig,
    spec: Mapping[str, Any],
    start: dt.date,
    end_exclusive: dt.date,
    parameters: Iterable[tuple[str, str | int]],
) -> str:
    """Build only a reviewed finance virtual-table route.

    Unlike `_odata_url`, this path contains function parameters. The complete
    entity/function/dimension tuple must match a signed spec before it is
    encoded, preventing this helper from becoming a generic path escape hatch.
    """

    if spec.get("transport") == "record_table":
        raise OneCEdoError(
            "query_builder_error",
            "Record-table capability нельзя направить в virtual-table builder.",
        )
    signature = (
        spec.get("entity"),
        spec.get("function"),
        tuple(spec.get("dimensions", ())),
    )
    allowed_signatures = {
        (
            candidate["entity"],
            candidate["function"],
            tuple(candidate.get("dimensions", ())),
        )
        for candidate in (
            *GENERAL_FINANCIAL_TURNOVER_SPECS.values(),
            *GENERAL_BALANCE_SPECS.values(),
        )
        if candidate.get("transport") != "record_table"
    }
    if signature not in allowed_signatures:
        raise OneCEdoError(
            "query_builder_error",
            "Внутренний virtual-table route не входит в подписанный registry.",
        )

    start_literal = f"datetime'{start.isoformat()}T00:00:00'"
    end_literal = f"datetime'{end_exclusive.isoformat()}T00:00:00'"
    function_parameters = [
        f"StartPeriod={start_literal}",
        f"EndPeriod={end_literal}",
    ]
    dimensions = tuple(spec.get("dimensions", ()))
    if dimensions:
        function_parameters.append(f"Dimensions='{','.join(dimensions)}'")
    route = (
        f"{spec['entity']}/{spec['function']}"
        f"({','.join(function_parameters)})"
    )
    encoded_route = urllib.parse.quote(route, safe="_/'(),=:")
    query = _odata_query(parameters)
    return f"{config.odata_base_url}{encoded_route}?{query}"


def _request_general_virtual_table(
    config: CompanyConfig,
    credentials: Credentials,
    spec: Mapping[str, Any],
    start: dt.date,
    end_exclusive: dt.date,
    parameters: Iterable[tuple[str, str | int]],
    *,
    diagnostic_stage: str,
) -> dict[str, Any]:
    """Read one fixed virtual table with the standard response-size guard."""

    url = _general_virtual_url(
        config,
        spec,
        start,
        end_exclusive,
        parameters,
    )
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
        raise OneCEdoError(
            "source_contract_mismatch",
            "1С вернула ответ, не соответствующий подписанному source contract.",
        ) from error
    if not isinstance(value, dict):
        raise OneCEdoError(
            "source_contract_mismatch",
            "1С вернула ответ, не соответствующий подписанному source contract.",
        )
    return value


def _general_financial_value(
    value: Any,
    expected_type: str,
    public_label: str,
) -> Any:
    """Normalize one already-validated scalar into the public finance schema."""

    if expected_type == "Edm.Guid":
        return _general_uuid_value(value, public_label)
    if expected_type == "Edm.String":
        return _general_text(value)
    if expected_type == "Edm.Boolean":
        return _normalized_boolean(value)
    if expected_type == "Edm.DateTime":
        return _normalized_1c_datetime(value, field_label=public_label)
    if expected_type == "Edm.Double":
        return _general_number(value)
    if expected_type == "Edm.Int64":
        return _general_integer(value)
    raise OneCEdoError(
        "query_builder_error",
        "Подписанный finance registry содержит неподдержанный scalar type.",
    )


def _general_financial_record(
    kind: str,
    spec: Mapping[str, Any],
    raw: dict[str, Any],
    *,
    source_kind: str,
) -> dict[str, Any]:
    """Return only semantic fields from one validated financial source row."""

    fields = spec["fields"]
    _validate_general_source_record(raw, fields)
    safe = _safe_selected_record(raw, fields)
    metric_fields = frozenset(spec.get("metrics", ()))
    dimensions: dict[str, Any] = {}
    metrics: dict[str, Any] = {}
    for source_field, public_label in spec["output"].items():
        normalized = _general_financial_value(
            safe.get(source_field),
            fields[source_field],
            public_label,
        )
        target = metrics if source_field in metric_fields else dimensions
        target[public_label] = normalized
    return {
        "kind": kind,
        "type": spec["sourceType"],
        "dimensions": dimensions,
        "metrics": metrics,
        "source": {
            "kind": source_kind,
            "type": spec["sourceType"],
        },
    }


def _general_financial_result(
    *,
    kind: str,
    rows: list[dict[str, Any]],
    page: int,
    limit: int,
    start: dt.date,
    end_exclusive: dt.date,
    matched_by: list[str],
    schema: dict[str, Any],
    config: CompanyConfig,
) -> dict[str, Any]:
    """Build the stable bounded envelope shared by all finance commands."""

    visible = rows[:limit]
    return {
        "kind": kind,
        "rows": visible,
        "count": len(visible),
        "period": {
            "dateFrom": start.isoformat(),
            "dateTo": (end_exclusive - dt.timedelta(days=1)).isoformat(),
        },
        "matchedBy": ["period", *matched_by],
        "pagination": {
            "page": page,
            "limit": limit,
            "truncated": len(rows) > limit,
        },
        "schema": schema,
        "limits": {
            "maxPeriodDays": GENERAL_MAX_FINANCIAL_PERIOD_DAYS,
            "maxPageSize": min(
                config.max_rows,
                GENERAL_MAX_FINANCIAL_PAGE_SIZE,
            ),
            "maxPages": min(config.max_pages, GENERAL_MAX_PAGES),
        },
        "readOnly": True,
    }


def command_general_get_financial_turnovers(
    args: argparse.Namespace,
) -> dict[str, Any]:
    """Read a bounded aggregate register; never calculate a P&L."""

    _general_require_sensitive(args)
    identity, config, credentials = _connected_context()
    kind = str(args.kind)
    spec = GENERAL_FINANCIAL_TURNOVER_SPECS[kind]
    start, end_exclusive = _general_financial_period(args)
    page, limit = _general_financial_page(args, config)
    filter_value, matched_by = _general_financial_filter(args, spec)
    dimension_fields = [
        field for field in spec["fields"] if field not in spec["metrics"]
    ]
    parameters: list[tuple[str, str | int]] = [
        ("$select", _selected_fields(spec["fields"])),
    ]
    if filter_value:
        parameters.append(("$filter", filter_value))
    if dimension_fields:
        parameters.append(
            ("$orderby", ",".join(f"{field} asc" for field in dimension_fields)),
        )
    parameters.extend([
        ("$skip", (page - 1) * limit),
        ("$top", limit + 1),
    ])
    schema = _general_signed_contract((("financial_turnover", kind),))
    try:
        if spec.get("transport") == "record_table":
            # Budget is deliberately the only turnover capability backed by
            # a raw record table. The virtual table cannot retain registrar
            # identity, so the helper owns the exact period/state/scope filter
            # and preserves the same bounded page contract.
            raw_rows = _general_budget_record_page(
                config,
                credentials,
                start=start,
                end_exclusive=end_exclusive,
                business_unit_id=str(args.business_unit_id),
                budget_item_id=str(getattr(args, "budget_item_id", "") or ""),
                skip=(page - 1) * limit,
                top=limit + 1,
            )
            source_kind = "record_table"
        else:
            raw_rows = _odata_rows(
                _request_general_virtual_table(
                    config,
                    credentials,
                    spec,
                    start,
                    end_exclusive,
                    parameters,
                    diagnostic_stage=f"general.financial.turnover.{kind}.search",
                ),
            )
            source_kind = "virtual_table"
        rows = [
            _general_financial_record(
                kind,
                spec,
                raw,
                source_kind=source_kind,
            )
            for raw in raw_rows[:limit + 1]
        ]
        save_access_state(identity, config, "connected")
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    return _general_financial_result(
        kind=kind,
        rows=rows,
        page=page,
        limit=limit,
        start=start,
        end_exclusive=end_exclusive,
        matched_by=matched_by,
        schema=schema,
        config=config,
    )


def _general_budget_record_page(
    config: CompanyConfig,
    credentials: Credentials,
    *,
    start: dt.date,
    end_exclusive: dt.date,
    business_unit_id: str = "",
    budget_item_id: str = "",
    registrar_id: str = "",
    skip: int,
    top: int,
) -> list[dict[str, Any]]:
    """Read one bounded page of active rows from the fixed budget register.

    The caller can supply only validated UUIDs and a bounded period. Entity,
    fields, state, reference types, operators and ordering remain signed
    constants, so replacing the unsuitable virtual table does not create a
    general raw-register query surface.
    """

    spec = GENERAL_FINANCIAL_TURNOVER_SPECS["budget"]
    if not business_unit_id and not registrar_id:
        raise OneCEdoError(
            "scope_filter_required",
            "Budget record table требует подразделение или exact registrar.",
        )
    scope_filter = ""
    if business_unit_id:
        filter_args = argparse.Namespace(
            organization_id="",
            business_unit_id=_uuid(business_unit_id, "business unit id"),
            account_id="",
            warehouse_id="",
            item_id="",
            budget_item_id=(
                _uuid(budget_item_id, "budget item id")
                if budget_item_id
                else ""
            ),
        )
        scope_filter, _matched = _general_financial_filter(filter_args, spec)
    elif budget_item_id:
        # Article-only access is never permitted. For exact-document
        # enrichment, the registrar UUID is the stronger scope and the article
        # is validated locally from the returned fixed row contract.
        raise OneCEdoError(
            "scope_filter_required",
            "Budget article без подразделения допустима только внутри exact registrar.",
        )
    date_field = str(spec["dateField"])
    clauses = [*spec["stateClauses"]]
    if not registrar_id:
        # Report queries remain period-bound. Exact-document enrichment uses
        # the immutable registrar UUID instead: a budget record may carry an
        # accounting period that differs from the document header date, and
        # combining both conditions can incorrectly erase a valid exact match.
        clauses.extend([
            f"{date_field} ge datetime'{start.isoformat()}T00:00:00'",
            f"{date_field} lt datetime'{end_exclusive.isoformat()}T00:00:00'",
        ])
    if scope_filter:
        clauses.append(scope_filter)
    if registrar_id:
        registrar = _uuid(registrar_id, "registrar id")
        clauses.append(
            "Recorder eq "
            f"cast(guid'{registrar}', 'Document_ВнутреннееПотребление')"
        )
    payload = _request_odata(
        config,
        credentials,
        str(spec["entity"]),
        (
            ("$select", _selected_fields(spec["fields"])),
            ("$filter", " and ".join(f"({item})" for item in clauses)),
            ("$orderby", "Period asc,Recorder asc,LineNumber asc"),
            ("$skip", skip),
            ("$top", top),
        ),
        diagnostic_stage="general.financial.turnover.budget.search",
    )
    return _odata_rows(payload)


def _general_budget_turnover_rows(
    config: CompanyConfig,
    credentials: Credentials,
    *,
    start: dt.date,
    end_exclusive: dt.date,
    business_unit_id: str = "",
    budget_item_id: str = "",
    registrar_id: str = "",
) -> tuple[list[dict[str, Any]], bool]:
    """Read a fixed, fully scoped budget-register drill-down.

    The helper walks at most the company-configured three pages.  A lookahead
    row on the final page makes incompleteness explicit; totals derived from a
    truncated source are never presented as reconciled.
    """

    spec = GENERAL_FINANCIAL_TURNOVER_SPECS["budget"]
    page_size = min(config.max_rows, GENERAL_MAX_FINANCIAL_PAGE_SIZE)
    max_pages = min(config.max_pages, GENERAL_MAX_PAGES)
    rows: list[dict[str, Any]] = []
    truncated = False
    for page in range(max_pages):
        raw_page = _general_budget_record_page(
            config,
            credentials,
            start=start,
            end_exclusive=end_exclusive,
            business_unit_id=business_unit_id,
            budget_item_id=budget_item_id,
            registrar_id=registrar_id,
            skip=page * page_size,
            top=page_size + 1,
        )
        visible_page = raw_page[:page_size]
        rows.extend(
            _general_financial_record(
                "budget",
                spec,
                raw,
                source_kind="record_table",
            )
            for raw in visible_page
        )
        has_more = len(raw_page) > page_size
        if not has_more:
            break
        if page + 1 == max_pages:
            truncated = True
    return rows, truncated


def _general_decimal_number(value: Decimal) -> int | float:
    """Serialize an accumulated amount without binary-float drift in sums."""

    integral = value.to_integral_value()
    return int(integral) if value == integral else float(value)


def _general_internal_consumption_recorder_type(value: str | None) -> bool:
    """Recognize only reviewed type spellings for the one allowed registrar."""

    return value in {
        "Document_ВнутреннееПотребление",
        "StandardODATA.Document_ВнутреннееПотребление",
    }


GENERAL_BUDGET_REGISTRAR_TYPES: dict[str, dict[str, str | None]] = {
    "Document_ВнутреннееПотребление": {
        "type": "internal_consumption",
        "documentKind": "internal_consumption",
        "role": "source",
    },
    "Document_ПриобретениеТоваровУслуг": {
        "type": "purchase",
        "documentKind": "purchase",
        "role": "source",
    },
    "Document_ПриобретениеУслугПрочихАктивов": {
        "type": "service_purchase",
        "documentKind": "service_purchase",
        "role": "source",
    },
    "Document_АвансовыйОтчет": {
        "type": "expense_report",
        "documentKind": "expense_report",
        "role": "source",
    },
    # This document is the independent month-end control. Live June checks
    # confirmed that it repeats the full direct amount by article. It must be
    # retained for reconciliation but never added to the source P&L total.
    "Document_РаспределениеПрочихЗатрат": {
        "type": "expense_distribution",
        "documentKind": None,
        "role": "control",
    },
}


def _general_budget_registrar_descriptor(
    value: str | None,
) -> dict[str, str | None] | None:
    """Map only reviewed bare or StandardODATA registrar type spellings."""

    normalized = str(value or "").removeprefix("StandardODATA.")
    return GENERAL_BUDGET_REGISTRAR_TYPES.get(normalized)


def _general_budget_item_reference(
    dimensions: Mapping[str, Any],
) -> str:
    """Validate one direct expense-article UUID from the signed source."""

    return _uuid(
        str(dimensions.get("budgetItemReference") or ""),
        "budget item id",
    )


def _general_enrich_internal_consumption_document(
    config: CompanyConfig,
    credentials: Credentials,
    document: dict[str, Any],
) -> dict[str, Any]:
    """Attach safe item/unit names and budget amounts to fixed goods rows."""

    lines = document.get("lines")
    if not isinstance(lines, list) or not document.get("lineInfo", {}).get("included"):
        return document
    items = _general_reference_map_by_ids(
        config,
        credentials,
        "item",
        (line.get("itemId") for line in lines),
    )
    # Internal-consumption rows commonly leave the packaging UUID empty. The
    # fixed item catalog already exposes the base measurement unit, so resolve
    # that safe UUID as a fallback instead of returning a false unknown unit.
    unit_ids: list[str | None] = []
    for line in lines:
        item = items.get(str(line.get("itemId") or "")) or {}
        unit_ids.append(line.get("unitId") or item.get("unitId"))
    units = _general_reference_map_by_ids(
        config,
        credentials,
        "unit",
        unit_ids,
    )
    business_unit_id = document.get("businessUnitId")
    document_date = document.get("date")
    if not business_unit_id or not isinstance(document_date, str):
        document["lineEnrichment"] = {
            "status": "partial",
            "reason": "document_scope_missing",
            "budgetSourceTruncated": False,
        }
        budget_rows: list[dict[str, Any]] = []
        budget_truncated = False
    else:
        try:
            date_value = dt.date.fromisoformat(document_date[:10])
        except ValueError as error:
            raise OneCEdoError(
                "capability_schema_changed",
                "Документ 1С вернул дату, непригодную для budget enrichment.",
            ) from error
        month_start = date_value.replace(day=1)
        month_end = (
            dt.date(month_start.year + 1, 1, 1)
            if month_start.month == 12
            else dt.date(month_start.year, month_start.month + 1, 1)
        )
        budget_rows, budget_truncated = _general_budget_turnover_rows(
            config,
            credentials,
            start=month_start,
            end_exclusive=month_end,
            # Exact registrar is already the narrowest safe scope and avoids
            # assuming that the document header and budget register use the
            # same business-unit UUID namespace.
            business_unit_id="",
            registrar_id=str(document["id"]),
        )
        document["lineEnrichment"] = {
            "status": "complete" if not budget_truncated else "truncated",
            "reason": None if not budget_truncated else "budget_source_limit",
            "budgetSourceTruncated": budget_truncated,
        }

    amounts_by_line: dict[int, Decimal] = {}
    articles_by_line: dict[int, set[str]] = {}
    budget_item_ids: set[str] = set()
    for row in budget_rows:
        dimensions = row["dimensions"]
        metrics = row["metrics"]
        if _uuid(str(dimensions.get("registrarReference") or ""), "registrar id") != document["id"]:
            raise OneCEdoError(
                "source_contract_mismatch",
                "Budget enrichment вернул посторонний registrar UUID.",
            )
        line_number = dimensions.get("lineNumber")
        amount = metrics.get("amount")
        article = _general_budget_item_reference(dimensions)
        if not _general_internal_consumption_recorder_type(
            str(dimensions.get("registrarType") or ""),
        ):
            raise OneCEdoError(
                "source_contract_mismatch",
                "Budget enrichment вернул неподдержанный registrar type.",
            )
        if not isinstance(line_number, int) or not isinstance(amount, (int, float)):
            raise OneCEdoError(
                "capability_schema_changed",
                "Budget enrichment вернул неполные line dimensions.",
            )
        amounts_by_line[line_number] = amounts_by_line.get(
            line_number,
            Decimal(0),
        ) + Decimal(str(amount))
        articles_by_line.setdefault(line_number, set()).add(article)
        budget_item_ids.add(article)

    # The document's own expense article may remain useful even when the
    # register has no turnover for a line, so resolve both fixed sources.
    for line in lines:
        expense_reference = line.get("expenseItemReference")
        expense_type = line.get("expenseItemType")
        if expense_reference and expense_type in {
            "ChartOfCharacteristicTypes_СтатьиРасходов",
            "StandardODATA.ChartOfCharacteristicTypes_СтатьиРасходов",
        }:
            budget_item_ids.add(_uuid(str(expense_reference), "expense item id"))
    budget_items = _general_reference_map_by_ids(
        config,
        credentials,
        "budget_item",
        budget_item_ids,
    )

    for line in lines:
        item = items.get(str(line.get("itemId") or ""))
        unit_id = line.get("unitId") or (item or {}).get("unitId")
        unit = units.get(str(unit_id or ""))
        line_number = line.get("lineNumber")
        article_ids = sorted(articles_by_line.get(line_number, set()))
        articles = [
            {
                "id": article_id,
                "name": (budget_items.get(article_id) or {}).get("name"),
            }
            for article_id in article_ids
        ]
        line["itemName"] = (item or {}).get("name")
        line["unit"] = (
            {
                "id": unit["id"],
                "name": unit.get("name"),
                "fullName": unit.get("fullName"),
                "symbol": unit.get("unitSymbol"),
            }
            if unit
            else None
        )
        line["amount"] = (
            _general_decimal_number(amounts_by_line[line_number])
            if line_number in amounts_by_line
            else None
        )
        line["budgetItems"] = articles
        expense_reference = line.get("expenseItemReference")
        line["expenseItem"] = (
            {
                "id": expense_reference,
                "type": line.get("expenseItemType"),
                "name": (budget_items.get(str(expense_reference)) or {}).get("name"),
            }
            if expense_reference
            else None
        )
    return document


def _general_document_line_expense_item_id(
    line: Mapping[str, Any],
) -> str | None:
    """Resolve the one reviewed expense-article reference shape on a line."""

    direct = line.get("expenseItemId")
    if direct:
        return _uuid(str(direct), "line expense item id")
    reference = line.get("expenseItemReference")
    reference_type = line.get("expenseItemType")
    if reference and reference_type in {
        "ChartOfCharacteristicTypes_СтатьиРасходов",
        "StandardODATA.ChartOfCharacteristicTypes_СтатьиРасходов",
    }:
        return _uuid(str(reference), "line expense item id")
    return None


def _general_enrich_document_line_references(
    config: CompanyConfig,
    credentials: Credentials,
    document: dict[str, Any],
) -> dict[str, Any]:
    """Attach safe names and stable source keys to fixed document lines.

    The helper resolves only the already allowlisted item, unit and expense
    article catalogs. A source-line key is deterministic from the immutable
    document identity and the 1C row identifier (falling back to line number),
    so a downstream recognition journal can prevent cross-period duplicates
    without storing or writing anything back to 1C.
    """

    lines = document.get("lines")
    if not isinstance(lines, list) or not document.get("lineInfo", {}).get("included"):
        return document
    items = _general_reference_map_by_ids(
        config,
        credentials,
        "item",
        (line.get("itemId") for line in lines),
    )
    unit_ids: list[str | None] = []
    expense_item_ids: set[str] = set()
    for line in lines:
        item = items.get(str(line.get("itemId") or "")) or {}
        unit_ids.append(line.get("unitId") or item.get("unitId"))
        expense_item_id = _general_document_line_expense_item_id(line)
        if expense_item_id:
            expense_item_ids.add(expense_item_id)
    units = _general_reference_map_by_ids(
        config,
        credentials,
        "unit",
        unit_ids,
    )
    expense_items = _general_reference_map_by_ids(
        config,
        credentials,
        "budget_item",
        expense_item_ids,
    )
    document_type = str(document.get("type") or document.get("kind") or "document")
    document_id = _uuid(str(document.get("id") or ""), "document id")
    for line in lines:
        item = items.get(str(line.get("itemId") or "")) or {}
        unit_id = line.get("unitId") or item.get("unitId")
        unit = units.get(str(unit_id or "")) or {}
        expense_item_id = _general_document_line_expense_item_id(line)
        line["itemName"] = line.get("itemName") or item.get("name")
        if line.get("unit") is None and unit:
            line["unit"] = {
                "id": unit["id"],
                "name": unit.get("name"),
                "fullName": unit.get("fullName"),
                "symbol": unit.get("unitSymbol"),
            }
        if expense_item_id:
            line["expenseItem"] = {
                "id": expense_item_id,
                "type": "expense_item",
                "name": (expense_items.get(expense_item_id) or {}).get("name"),
            }
        stable_line_id = line.get("sourceLineId") or line.get("lineNumber")
        line["sourceLineKey"] = (
            f"{document_type}:{document_id}:{stable_line_id}"
            if stable_line_id is not None
            else None
        )
    return document


def command_general_get_budget_turnover_details(
    args: argparse.Namespace,
) -> dict[str, Any]:
    """Return one budget article total and its fixed registrar headers."""

    _general_require_sensitive(args)
    identity, config, credentials = _connected_context()
    start, end_exclusive = _general_financial_period(args)
    _page, limit = _general_financial_page(
        argparse.Namespace(page=1, limit=args.limit),
        config,
    )
    business_unit_id = _uuid(args.business_unit_id, "business unit id")
    budget_item_id = _uuid(args.budget_item_id, "budget item id")
    schema = _general_signed_contract(
        (
            ("financial_turnover", "budget"),
            ("reference", "budget_item"),
            ("document", "internal_consumption"),
            ("document", "purchase"),
            ("document", "service_purchase"),
            ("document", "expense_report"),
        ),
    )
    try:
        budget_item_matches = _general_reference_by_id(
            config,
            credentials,
            "budget_item",
            budget_item_id,
        )
        if len(budget_item_matches) > 1:
            raise OneCEdoError(
                "source_contract_mismatch",
                "1С вернула неоднозначную бюджетную статью.",
            )
        rows, source_truncated = _general_budget_turnover_rows(
            config,
            credentials,
            start=start,
            end_exclusive=end_exclusive,
            business_unit_id=business_unit_id,
            budget_item_id=budget_item_id,
        )
        grouped: dict[tuple[str, str], Decimal] = {}
        grouped_rows: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for row in rows:
            dimensions = row["dimensions"]
            metrics = row["metrics"]
            article = _general_budget_item_reference(dimensions)
            unit = _uuid(
                str(dimensions.get("businessUnitId") or ""),
                "business unit id",
            )
            registrar = _uuid(
                str(dimensions.get("registrarReference") or ""),
                "registrar id",
            )
            registrar_type = str(dimensions.get("registrarType") or "")
            amount = metrics.get("amount")
            if article != budget_item_id or unit != business_unit_id:
                raise OneCEdoError(
                    "source_contract_mismatch",
                    "Budget drill-down вернул запись вне exact scope.",
                )
            if not isinstance(amount, (int, float)) or not registrar_type:
                raise OneCEdoError(
                    "capability_schema_changed",
                    "Budget drill-down вернул неполный registrar row.",
                )
            key = (registrar_type, registrar)
            grouped[key] = grouped.get(key, Decimal(0)) + Decimal(str(amount))
            grouped_rows.setdefault(key, []).append(row)

        registrars: list[dict[str, Any]] = []
        for (registrar_type, registrar), amount in grouped.items():
            descriptor = _general_budget_registrar_descriptor(
                registrar_type,
            )
            entry: dict[str, Any] = {
                "type": descriptor["type"] if descriptor else "unsupported",
                "role": descriptor["role"] if descriptor else "unknown",
                "sourceType": registrar_type,
                "id": registrar,
                "number": None,
                "date": None,
                "postingStatus": None,
                "amount": _general_decimal_number(amount),
                "resolutionStatus": "unsupported_registrar_type",
            }
            document_kind = descriptor.get("documentKind") if descriptor else None
            if document_kind:
                matches = _general_documents_by_id(
                    config,
                    credentials,
                    str(document_kind),
                    registrar,
                    include_lines=False,
                    line_limit=0,
                )
                if len(matches) > 1:
                    raise OneCEdoError(
                        "source_contract_mismatch",
                        "1С вернула неоднозначный registrar document.",
                    )
                if matches:
                    entry.update(
                        {
                            "number": matches[0].get("number"),
                            "date": matches[0].get("date"),
                            "postingStatus": matches[0].get("postingStatus"),
                            "resolutionStatus": "resolved",
                        },
                    )
                else:
                    entry["resolutionStatus"] = "not_found"
            elif descriptor and descriptor["role"] == "control":
                entry["resolutionStatus"] = "control_only"
            registrars.append(entry)
        registrars.sort(
            key=lambda item: (
                str(item.get("date") or ""),
                str(item.get("number") or ""),
                str(item["id"]),
            ),
        )
        source_total = sum(
            (
                amount
                for (registrar_type, _registrar), amount in grouped.items()
                if (
                    (_general_budget_registrar_descriptor(registrar_type) or {}).get(
                        "role",
                    )
                    == "source"
                )
            ),
            Decimal(0),
        )
        control_total = sum(
            (
                amount
                for (registrar_type, _registrar), amount in grouped.items()
                if (
                    (_general_budget_registrar_descriptor(registrar_type) or {}).get(
                        "role",
                    )
                    == "control"
                )
            ),
            Decimal(0),
        )
        unknown_total = sum(
            (
                amount
                for (registrar_type, _registrar), amount in grouped.items()
                if _general_budget_registrar_descriptor(registrar_type) is None
            ),
            Decimal(0),
        )
        unresolved_sources = [
            item
            for item in registrars
            if item["role"] == "source" and item["resolutionStatus"] != "resolved"
        ]
        control_matches = source_total == control_total
        coverage_complete = (
            not source_truncated
            and unknown_total == 0
            and not unresolved_sources
            and control_matches
        )
        save_access_state(identity, config, "connected")
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    return {
        "kind": "budget",
        "period": {
            "dateFrom": start.isoformat(),
            "dateTo": (end_exclusive - dt.timedelta(days=1)).isoformat(),
        },
        "businessUnitId": business_unit_id,
        "budgetItem": (
            budget_item_matches[0]
            if budget_item_matches
            else {"id": budget_item_id, "kind": "budget_item", "name": None}
        ),
        "total": _general_decimal_number(source_total),
        "registrars": registrars[:limit],
        "count": min(len(registrars), limit),
        "reconciliation": {
            "complete": coverage_complete,
            "sourceAmountSum": _general_decimal_number(source_total),
            "controlAmountSum": _general_decimal_number(control_total),
            "controlMatches": control_matches,
            "unknownAmountSum": _general_decimal_number(unknown_total),
            # Kept for compatible consumers; it now means the direct source
            # registrar sum, never source + month-end distribution.
            "registrarAmountSum": _general_decimal_number(source_total),
            "sourceRows": len(rows),
            "unknownRegistrarTypes": sorted({
                str(item["sourceType"])
                for item in registrars
                if item["role"] == "unknown"
            }),
            "unresolvedSourceRegistrars": len(unresolved_sources),
        },
        "pagination": {
            "limit": limit,
            "truncated": source_truncated or len(registrars) > limit,
            "sourceTruncated": source_truncated,
        },
        "matchedBy": ["period", "business_unit", "budget_item"],
        "schema": schema,
        "readOnly": True,
    }


def command_general_search_financial_records(
    args: argparse.Namespace,
) -> dict[str, Any]:
    """Read bounded ledger entries or bank-document headers."""

    _general_require_sensitive(args)
    identity, config, credentials = _connected_context()
    kind = str(args.kind)
    spec = GENERAL_FINANCIAL_RECORD_SPECS[kind]
    start, end_exclusive = _general_financial_period(args)
    page, limit = _general_financial_page(args, config)
    scope_filter, matched_by = _general_financial_filter(args, spec)
    date_field = str(spec["dateField"])
    clauses = [
        *spec.get("stateClauses", ()),
        f"{date_field} ge datetime'{start.isoformat()}T00:00:00'",
        f"{date_field} lt datetime'{end_exclusive.isoformat()}T00:00:00'",
    ]
    if scope_filter:
        clauses.append(scope_filter)
    schema = _general_signed_contract((("financial_record", kind),))
    try:
        raw_rows = _odata_rows(
            _request_odata(
                config,
                credentials,
                spec["entity"],
                (
                    ("$select", _selected_fields(spec["fields"])),
                    (
                        "$filter",
                        " and ".join(f"({clause})" for clause in clauses),
                    ),
                    ("$orderby", f"{date_field} desc"),
                    ("$skip", (page - 1) * limit),
                    ("$top", limit + 1),
                ),
                diagnostic_stage=f"general.financial.record.{kind}.search",
            ),
        )
        rows = [
            _general_financial_record(
                kind,
                spec,
                raw,
                source_kind=(
                    "register_record"
                    if kind == "account_entry"
                    else "document"
                ),
            )
            for raw in raw_rows[:limit + 1]
        ]
        save_access_state(identity, config, "connected")
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    return _general_financial_result(
        kind=kind,
        rows=rows,
        page=page,
        limit=limit,
        start=start,
        end_exclusive=end_exclusive,
        matched_by=matched_by,
        schema=schema,
        config=config,
    )


def command_general_get_balance_and_turnovers(
    args: argparse.Namespace,
) -> dict[str, Any]:
    """Read a verified bounded accounting or stock balance virtual table."""

    _general_require_sensitive(args)
    identity, config, credentials = _connected_context()
    kind = str(args.kind)
    spec = GENERAL_BALANCE_SPECS[kind]
    start, end_exclusive = _general_financial_period(args)
    page, limit = _general_financial_page(args, config)
    filter_value, matched_by = _general_financial_filter(args, spec)
    dimension_fields = [
        field for field in spec["fields"] if field not in spec["metrics"]
    ]
    parameters: list[tuple[str, str | int]] = [
        ("$select", _selected_fields(spec["fields"])),
        ("$filter", filter_value),
        ("$orderby", ",".join(f"{field} asc" for field in dimension_fields)),
        ("$skip", (page - 1) * limit),
        ("$top", limit + 1),
    ]
    schema = _general_signed_contract((("balance", kind),))
    try:
        raw_rows = _odata_rows(
            _request_general_virtual_table(
                config,
                credentials,
                spec,
                start,
                end_exclusive,
                parameters,
                diagnostic_stage=f"general.balance.{kind}.search",
            ),
        )
        rows = [
            _general_financial_record(
                kind,
                spec,
                raw,
                source_kind="virtual_table",
            )
            for raw in raw_rows[:limit + 1]
        ]
        save_access_state(identity, config, "connected")
    except AuthenticationError:
        _mark_auth_failure(identity, config)
        raise
    return _general_financial_result(
        kind=kind,
        rows=rows,
        page=page,
        limit=limit,
        start=start,
        end_exclusive=end_exclusive,
        matched_by=matched_by,
        schema=schema,
        config=config,
    )


def command_general_get_balances(args: argparse.Namespace) -> dict[str, Any]:
    # Retain the old command so existing agents fail safely with an actionable
    # transition instead of silently changing a previously unsupported shape.
    return {
        "kind": str(args.kind),
        "status": "unsupported",
        "reason": "use_get_balance_and_turnovers",
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
            _validate_general_source_record(row, GENERAL_EDO_LINK_FIELDS)
            safe = _safe_selected_record(row, DOCUMENT_SELECT_FIELDS)
            reference = _general_uuid_value(safe.get("Ref_Key"), "EDO document id")
            if reference is None:
                raise OneCEdoError(
                    "capability_schema_changed",
                    "Фиксированный EDO link source больше не соответствует подписанному registry.",
                )
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
    schema = _general_signed_contract(all_schema_capabilities)
    try:
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
                    "source_contract_mismatch",
                    "1С вернула неоднозначный результат для фиксированного документа.",
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

    connect = subparsers.add_parser(
        "connect",
        help="Connect personal credentials through a protected local browser page",
    )
    connect.add_argument(
        "--terminal-prompts",
        action="store_true",
        help="Use the current visible terminal instead of the protected local browser page",
    )
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

    connect = subparsers.add_parser(
        "connect",
        help="Connect personal credentials through a protected local browser page",
    )
    connect.add_argument(
        "--terminal-prompts",
        action="store_true",
        help="Use the current visible terminal instead of the protected local browser page",
    )
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

    forget = subparsers.add_parser("forget-credentials")
    forget.set_defaults(handler=command_forget_credentials)

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

    def add_financial_arguments(
        command: argparse.ArgumentParser,
        kinds: Iterable[str],
    ) -> None:
        """Attach the same bounded scope contract to every finance command."""

        command.add_argument("--kind", choices=tuple(kinds), required=True)
        command.add_argument("--date-from", required=True)
        command.add_argument("--date-to", required=True)
        command.add_argument("--organization-id", default="")
        command.add_argument("--business-unit-id", default="")
        command.add_argument("--account-id", default="")
        command.add_argument("--warehouse-id", default="")
        command.add_argument("--item-id", default="")
        command.add_argument("--budget-item-id", default="")
        command.add_argument("--page", type=int, default=1)
        command.add_argument("--limit", type=int, default=25)
        command.add_argument("--include-sensitive", action="store_true")

    financial_turnovers = subparsers.add_parser("get-financial-turnovers")
    add_financial_arguments(
        financial_turnovers,
        GENERAL_FINANCIAL_TURNOVER_SPECS,
    )
    financial_turnovers.set_defaults(
        handler=command_general_get_financial_turnovers,
    )

    budget_details = subparsers.add_parser("get-budget-turnover-details")
    budget_details.add_argument("--date-from", required=True)
    budget_details.add_argument("--date-to", required=True)
    budget_details.add_argument("--business-unit-id", required=True)
    budget_details.add_argument("--budget-item-id", required=True)
    budget_details.add_argument("--limit", type=int, default=50)
    budget_details.add_argument("--include-sensitive", action="store_true")
    budget_details.set_defaults(
        handler=command_general_get_budget_turnover_details,
    )

    financial_records = subparsers.add_parser("search-financial-records")
    add_financial_arguments(
        financial_records,
        GENERAL_FINANCIAL_RECORD_SPECS,
    )
    financial_records.set_defaults(
        handler=command_general_search_financial_records,
    )

    balance_turnovers = subparsers.add_parser("get-balance-and-turnovers")
    add_financial_arguments(balance_turnovers, GENERAL_BALANCE_SPECS)
    balance_turnovers.set_defaults(
        handler=command_general_get_balance_and_turnovers,
    )

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


def _write_json_stdout(payload: Mapping[str, Any]) -> None:
    """Emit one machine-readable JSON line as UTF-8 on every platform.

    On a redirected Windows stdout, Python normally chooses the active ANSI
    code page (for example, cp1251) for ``print``. The Trelio host consumes the
    runtime protocol as UTF-8, so relying on that locale silently corrupts
    Cyrillic business fields before the host can parse them. Writing through
    the underlying binary stream makes the wire encoding explicit and leaves
    no locale-dependent conversion in the protocol path.

    ``StringIO`` and other text-only streams have no ``buffer`` attribute.
    They are used by tests and embedders that already exchange Unicode text,
    so retain a small text fallback for those non-process streams.
    """

    line = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
    binary_stdout = getattr(sys.stdout, "buffer", None)
    if binary_stdout is not None:
        binary_stdout.write(line.encode("utf-8"))
        binary_stdout.flush()
        return
    sys.stdout.write(line)
    sys.stdout.flush()


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
        _write_json_stdout({"ok": True, **result})
        return 0
    except OneCEdoError as error:
        if BROWSER_PROMPT_SESSION is not None:
            BROWSER_PROMPT_SESSION.finish(
                title="Подключение не завершено",
                message="Вернитесь в Codex, проверьте сообщение об ошибке и запустите connect заново.",
            )
        _write_json_stdout(
            {
                "ok": False,
                "error": _safe_error_payload(error),
            },
        )
        return error.exit_code
    except KeyboardInterrupt:
        if BROWSER_PROMPT_SESSION is not None:
            BROWSER_PROMPT_SESSION.finish(
                title="Подключение отменено",
                message="Можно закрыть вкладку и вернуться в Codex.",
            )
        _write_json_stdout(
            {
                "ok": False,
                "error": {"code": "cancelled", "message": "Операция отменена."},
            },
        )
        return 130
    except Exception:
        if BROWSER_PROMPT_SESSION is not None:
            BROWSER_PROMPT_SESSION.finish(
                title="Подключение не завершено",
                message="Вернитесь в Codex и при необходимости запустите connect заново.",
            )
        # Unexpected library/platform failures must not emit a traceback that
        # could contain a local path, URL or credential-bearing header. The
        # detailed exception remains deliberately outside agent-visible output.
        _write_json_stdout(
            {
                "ok": False,
                "error": {
                    "code": "internal_error",
                    "message": "Runtime завершился с безопасной внутренней ошибкой.",
                },
            },
        )
        return 1
    finally:
        shutdown_browser_prompt_session()


if __name__ == "__main__":
    raise SystemExit(main())
