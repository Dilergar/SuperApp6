<!-- Source of the version 1 draft (consents-publish-initial.cjs). After publication the only source of the text is the database: a new version is drafted and published from the platform console. Operator details are substituted on publication. -->
<!-- summary -->
- The personal data of employees, customers and counterparties that an organization enters into the platform belongs to the organization. It is the owner of the database; the platform is the operator acting on its instruction.
- We process this data only to run the organization's services, store it in Kazakhstan and encrypt it with the organization's own key.
- We report a security breach to the organization without delay so that it can notify the authorised body within the statutory period.
- On termination the data can be exported; then it is destroyed together with the encryption keys.

<!-- body -->
# Data Processing Agreement

Concluded between the Organization (the owner of the database containing personal data) and {{legalName}}, BIN {{bin}}, address: {{address}} (the operator acting on instruction), under the Law of the Republic of Kazakhstan "On Personal Data and Their Protection".

## 1. Roles

1.1. **The Organization is the owner.** It determines the purposes and the composition of the personal data of its employees, candidates, customers, counterparties and their representatives that it enters into the workspace, and is responsible for the lawfulness of collecting it, including obtaining the consents of the data subjects.

1.2. **The platform Operator processes this data on the Organization's instruction** — only to provide the platform functions and only under its instructions, which are the actions of the Organization and its employees in the interface and via the API.

1.3. With respect to people's personal accounts (phone number, profile, personal space) the Operator acts independently — on the basis of the person's own consent. This data does not belong to the Organization.

## 2. Subject of the instruction

Storage, systematisation, display, transfer within the workspace according to the rights set by the Organization, generation of documents, sending of notifications, backups, destruction.

## 3. Obligations of the Operator

- to process the data only for the purposes of this agreement and not to use it for its own purposes;
- to store the database on servers in the Republic of Kazakhstan;
- to encrypt the Organization's personal data with a key belonging to that Organization; freezing or destroying the key makes the data unreadable;
- to admit its staff to the data only when necessary (support upon request, security), with a separate confirmation, a stated reason and a record in an immutable log;
- to keep a register of data transfers to third parties;
- to help the Organization respond to data subjects' requests — with the platform tools (search, export, correction, deletion).

## 4. Engaged persons

The Operator may engage third parties in the processing only according to this list and is liable to the Organization for their actions:

| Person | Country | Purpose |
|---|---|---|
| KazInfoTeh LLP | Kazakhstan | sending SMS (codes, signing links, notifications) |
| National Information Technologies JSC — NCA RK | Kazakhstan | verification of electronic digital signatures |
| Push delivery services (Google, Mozilla, Apple, Microsoft) | USA | delivery of notifications to employees' devices — on the basis of their personal consent |

Webhook addresses are set by the Organization itself: data is transferred to them on its instruction, and the recipient is deemed engaged by the Organization, not by the Operator. The Operator announces changes to the list in advance — by publishing a new version of this agreement.

## 5. Security breach

Having discovered a security breach affecting the Organization's data, the Operator notifies its owner and administrators without delay, stating the known circumstances: what happened, which data is affected, what measures have been taken. Notifying the authorised body and the data subjects with respect to the Organization's data is the duty of the Organization as the owner; the Operator assists and provides information from its logs.

## 6. Term, return and destruction

6.1. The agreement is valid for as long as the organization exists on the platform.

6.2. Before the organization is deleted, the Organization may export its data. After deletion the organization stays in the archive for the established period (restoration is possible), then the data is destroyed and the encryption keys are destroyed irreversibly.

6.3. Only the information the Operator must keep by law is retained (payment documents, documents signed by the parties and proofs of signing) — with restricted access.

## 7. Audit

The Organization may request from the Operator information about the protection measures and the engaged persons. Requests are sent to {{privacyEmail}}.

## 8. Liability

The liability of the parties is determined by the "Terms for Organizations". Each party is liable to the data subjects and the authorised body for the part of the processing it determines itself.
