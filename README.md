# La Distillerie — Commandes Repas v0.1.0

Webapp légère pour prendre les commandes repas d’une équipe événementielle et agréger les quantités en temps réel.

## Fonctionnalités

- liste persistante des personnes ;
- lien personnel stable par personne ;
- création d’un repas et sélection des présents ;
- catégories libres (plat, boisson froide, boisson chaude, dessert...) ;
- 1 à N choix autorisés par catégorie ;
- ouverture / fermeture des commandes ;
- modification tant que le repas est ouvert ;
- compteur réponses / manquants ;
- agrégation automatique par produit ;
- QR général ;
- vue nominative de distribution ;
- statut remis / à remettre ;
- mise à jour temps réel par Socket.IO ;
- SQLite local persistant ;
- UI alignée sur le portail La Distillerie v1.2.2.

## Lancement Docker

1. Copier `.env.example` vers `.env`.
2. Changer impérativement `ADMIN_PASSWORD` et `SESSION_SECRET`.
3. Adapter `PUBLIC_BASE_URL` à l’URL publique.
4. Vérifier que le réseau Docker externe `web-proxy` existe.
5. Lancer :

    docker compose up -d --build

Accès local : `http://127.0.0.1:8920`

- commande : `/order`
- administration : `/admin`
- healthcheck : `/health`

## Nginx Proxy Manager

Le conteneur rejoint le réseau externe `web-proxy`. Dans NPM :

- Forward Hostname : `distillerie-repas`
- Forward Port : `3000`
- Scheme : `http`
- Websockets Support : **ON**
- SSL : recommandé

`PUBLIC_BASE_URL` doit ensuite contenir le domaine final, par exemple `https://repas.example.fr`.

## Sécurité

Le mot de passe de fallback `distillerie` existe uniquement pour permettre un test immédiat. Ne jamais exposer l’application publiquement avec cette valeur.

Les liens personnels sont des tokens aléatoires. Le QR général affiche la liste des présents et convient à un usage événementiel interne. Pour un niveau de confidentialité supérieur, diffuser uniquement les liens personnels et ne pas communiquer `/order`.

## Données

Base : `./data/repas.sqlite`

Le volume `./data:/app/data` conserve les personnes, repas et commandes après recréation du conteneur.
