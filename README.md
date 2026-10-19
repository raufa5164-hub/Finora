# Finora — Personal Finance Manager

Finora is a personal finance web application for organizing income, expenses, wallets, and financial goals in one place. It uses Firebase for authentication and cloud synchronization, with offline-first support to help users keep working when their internet connection is unavailable.

**Live Demo:** https://finora-236a5.web.app  
**GitHub Repository:**https://github.com/raufa5164-hub/ABDUL-RAUF

> Track smarter. Plan better. Take control of your money.

## Features

- **Expense tracking** — Record and manage day-to-day expenses.
- **Income management** — Keep income and expenses organized.
- **Wallet management** — Organize finances across wallets and payment sources.
- **Financial goals** — Set and monitor personal financial goals.
- **Google Sign-In** — Authenticate with Google using Firebase Authentication.
- **Cloud synchronization** — Synchronize user data across devices with Cloud Firestore.
- **Offline-first saving and sync** — Save data locally while offline and synchronize when connectivity returns.
- **Installable Progressive Web App (PWA)** — Use an app-like experience on supported devices.
- **PDF export** — Export financial information to PDF.
- **Excel export** — Export financial data for further analysis.
- **Email reports** — Send financial reports by email.

### AI roadmap

AI-powered spending analysis and personalized financial recommendations are planned for a future release. These features are not currently presented as implemented.

## Tech Stack

| Technology | Purpose |
|---|---|
| HTML5 | Application structure |
| CSS3 | Styling and responsive layout |
| JavaScript | Application logic and interactivity |
| Firebase Authentication | Google sign-in and authentication |
| Cloud Firestore | Cloud data storage and synchronization |
| Browser storage | Local persistence and offline workflows |
| PWA technologies | Installable app experience |

## Getting Started

### Prerequisites

- A modern web browser
- [Git](https://git-scm.com/)
- [Node.js and npm](https://nodejs.org/) for a local static server
- A Firebase project if you want to configure your own instance

### 1. Clone the repository

```bash
git clone https://github.com/abdulrahmanaliyt/Finora.git
cd Finora
```

### 2. Configure Firebase

To configure your own instance:

1. Create a Firebase project and register a Web App.
2. Enable Google as a sign-in provider in Firebase Authentication.
3. Create a Cloud Firestore database.
4. Add the local and deployed domains to Firebase Authentication's authorized domains as needed.
5. Configure the Firebase web app settings in the location expected by the source code.
6. Configure and test Firestore Security Rules so users can access only their own records.

Firebase web configuration is designed for client-side use, but it is not a security boundary. Protect your database with Security Rules. Never commit service-account private keys, passwords, or other server-side secrets.

### 3. Run locally

For a static HTML/CSS/JavaScript project, start a local server from the project root:

```bash
npx serve .
```

Open the local URL printed in the terminal (often `http://localhost:3000`).

The exact setup can vary with the repository's file structure. If email reports or other integrations require configuration, follow the settings expected by the source code and do not commit private credentials.

## Security and Privacy

Financial information can be sensitive. Before using real data:

- Keep Firestore Security Rules enabled and restrict users to their own records.
- Never commit service-account keys, passwords, private credentials, `.env` files containing secrets, or real personal financial records.
- Review API-key restrictions and third-party service settings where applicable.
- Test authentication, access control, offline behavior, and synchronization.
- Treat exported PDF and Excel reports as sensitive files and store them securely.

## Deployment

The live demo is hosted on Firebase Hosting. To deploy your own configured copy, see the [Firebase Hosting documentation](https://firebase.google.com/docs/hosting).

## Roadmap

Potential future improvements include:

- AI-assisted spending analysis and personalized budgeting suggestions
- More financial trends and visualizations
- Budget limits and spending alerts
- Enhanced recurring-transaction workflows
- Further accessibility and usability improvements

Roadmap items are planned ideas and are not available until implemented and documented.

## Contributing

Suggestions, bug reports, and contributions are welcome.

1. Fork the repository.
2. Create a feature branch.
3. Make your changes and test them.
4. Open a pull request describing your changes.

## Disclaimer

Finora is a personal finance management project for organizing and reviewing financial information. It is not a bank or payment processor and does not provide professional financial advice.

## Author

**Abdul Rauf**

- GitHub: [@raufa5164-hub](https://github.com/raufa5164-hub/ABDUL-RAUF)
- Project: [Finora on GitHub](https://github.com/raufa5164-hub/ABDUL-RAUF)
- Live Demo: [finora-236a5.web.app](https://finora-236a5.web.app)

## License

No license has been selected for this repository yet. Until a license is added, others should not assume they have permission to reuse, modify, or distribute this project's code.

If you decide to make the project reusable, review the available licenses and add your chosen license in a `LICENSE` file. The [MIT License](https://choosealicense.com/licenses/mit/) is one common option for portfolio projects.
