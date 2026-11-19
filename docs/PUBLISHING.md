# Put Solid Studio on GitHub

The source archive contains the complete application, its bundled browser dependencies, container configuration, tests and documentation. It is ready to become the root of a Git repository. The standalone TrueNAS installer is a release download; it is not a substitute for the source files.

## Upload through GitHub

1. Extract `Solid_Studio_v1.2.0.zip` into a new, empty folder.
2. Create an empty repository in your GitHub account. Choose **Public** if everyone should be able to find and download it. The archive already includes a README, MIT licence and `.gitignore`, so you do not need GitHub to generate those files.
3. Upload the extracted files and folders to the repository root. `server.py`, `README.md`, `Dockerfile` and `compose.yaml` should appear directly at the root, alongside `static/`, `tests/`, `tools/`, `docs/` and `licenses/`.
4. Include the dotfiles and dotfolder: **`.github/`**, **`.gitignore`**, **`.dockerignore`** and **`.env.example`**. If your file picker hides them, enable hidden files or use the Git commands below. The workflow must end up at `.github/workflows/test.yml` for automatic checks to run.
5. Commit the upload. The **Actions** tab then runs the server, geometry, packaging and container checks. A local installation does not depend on GitHub Actions.

Upload the archive contents, not just the ZIP as a repository file. Keep your live installation's `data/`, `.env`, database backups and personal model exports out of the repository. None are present in the supplied clean source archive.

## Upload with Git

Open a terminal in the extracted source folder. Replace the example remote with the repository URL shown by GitHub:

```sh
git init -b main
git add --all
git commit -m "Publish Solid Studio 1.2.0"
git remote add origin https://github.com/YOUR-ACCOUNT/solid-studio.git
git push -u origin main
```

Use GitHub's normal authentication flow. Do not put a password or access token into the remote URL or a checked-in file. The supplied `.gitignore` excludes local data, environment files, generated release files and exported model/project files.

## Offer downloadable releases

Generate a release from the source checkout with Python 3.10 or newer:

```sh
python3 tools/package.py --output ./release
```

That produces:

- `Solid_Studio_v1.2.0.zip`: complete source for Docker, Python or development.
- `install_solid_studio.py`: a self-contained TrueNAS install/update script with the same source embedded and checksum-verified.
- `Solid_Studio_Quickstart.txt`: installation and use instructions.
- `SHA256SUMS_Solid_Studio.txt`: checksums for the other three files.

You can attach those four files to a GitHub release tagged `v1.2.0`. Users of other operating systems can use the source ZIP with Docker or Python; they do not need the TrueNAS installer.

The top-level [MIT licence](../LICENSE) covers Solid Studio's original code. Keep that licence and [the third-party notices](../THIRD_PARTY_NOTICES.md) when redistributing the package. The app's footer links to [ranolph](https://github.com/ranolph).
