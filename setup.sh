#!/usr/bin/env bash
#
# Billing CVLMEDIA - Setup Script untuk Server Baru
# Script ini menginstall semua yang dibutuhkan untuk billing system di Ubuntu 22.04
# Setelah selesai, aplikasi siap untuk dibuka di UI dan dikonfigurasi
#

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Banner
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     Billing Kalimasada - Setup Script untuk Server Baru   ║${NC}"
echo -e "${GREEN}║              Ubuntu 22.04 LTS Ready                      ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if running as root
if [[ $EUID -eq 0 ]]; then
   echo -e "${YELLOW}[!] Warning: Running as root. Some commands may not need sudo.${NC}"
   SUDO=""
else
   SUDO="sudo"
   echo -e "${BLUE}[i] Running as regular user. Will use sudo when needed.${NC}"
fi

# Deteksi OS
detect_os() {
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        OS=$ID
        OS_VERSION=$VERSION_ID
        echo -e "${GREEN}[+] OS Detected: ${OS} ${OS_VERSION}${NC}"
    else
        echo -e "${RED}[!] Cannot detect OS type${NC}"
        exit 1
    fi
}

# Update sistem
update_system() {
    echo -e "${CYAN}[*] Updating system packages...${NC}"
    $SUDO apt-get update -qq
    $SUDO apt-get upgrade -y -qq
    echo -e "${GREEN}[+] System updated${NC}"
}

# Install dependencies sistem
install_system_dependencies() {
    echo -e "${CYAN}[*] Installing system dependencies...${NC}"
    $SUDO apt-get install -y \
        build-essential \
        git \
        curl \
        wget \
        python3 \
        make \
        g++ \
        libssl-dev \
        libsqlite3-dev \
        sqlite3 \
        mysql-client \
        ca-certificates \
        gnupg \
        lsb-release \
        > /dev/null 2>&1
    echo -e "${GREEN}[+] System dependencies installed${NC}"
}

# Install Node.js 20.x
install_nodejs() {
    if command -v node &> /dev/null; then
        NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [[ $NODE_VERSION -ge 20 ]]; then
            echo -e "${GREEN}[+] Node.js already installed: $(node -v)${NC}"
            return
        else
            echo -e "${YELLOW}[!] Node.js version is too old: $(node -v)${NC}"
            echo -e "${CYAN}[*] Installing Node.js 20.x...${NC}"
        fi
    else
        echo -e "${CYAN}[*] Installing Node.js 20.x...${NC}"
    fi
    
    # Install Node.js 20.x from NodeSource
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - > /dev/null 2>&1
    $SUDO apt-get install -y nodejs > /dev/null 2>&1
    
    echo -e "${GREEN}[+] Node.js installed: $(node -v)${NC}"
    echo -e "${GREEN}[+] npm installed: $(npm -v)${NC}"
}

# Install PM2
install_pm2() {
    if command -v pm2 &> /dev/null; then
        echo -e "${GREEN}[+] PM2 already installed: $(pm2 -v)${NC}"
    else
        echo -e "${CYAN}[*] Installing PM2...${NC}"
        $SUDO npm install -g pm2 > /dev/null 2>&1
        echo -e "${GREEN}[+] PM2 installed: $(pm2 -v)${NC}"
    fi
}

# Install npm dependencies
install_npm_dependencies() {
    echo -e "${CYAN}[*] Installing npm dependencies (this may take a while)...${NC}"
    
    # Install dependencies
    npm install
    
    # Check if sqlite3 installation failed
    if [ $? -ne 0 ]; then
        echo -e "${YELLOW}[!] npm install had issues, trying to rebuild sqlite3...${NC}"
        npm rebuild sqlite3
        
        if [ $? -ne 0 ]; then
            echo -e "${YELLOW}[!] Rebuild failed, trying to build from source...${NC}"
            npm install sqlite3 --build-from-source
        fi
    fi
    
    echo -e "${GREEN}[+] npm dependencies installed${NC}"
}

# Setup direktori
setup_directories() {
    echo -e "${CYAN}[*] Setting up directories...${NC}"
    
    # Create logs directory
    if [ ! -d "logs" ]; then
        mkdir -p logs
        echo -e "${GREEN}[+] Created logs directory${NC}"
    else
        echo -e "${BLUE}[i] logs directory already exists${NC}"
    fi
    
    # Create whatsapp-session directory
    if [ ! -d "whatsapp-session" ]; then
        mkdir -p whatsapp-session
        echo -e "${GREEN}[+] Created whatsapp-session directory${NC}"
    else
        echo -e "${BLUE}[i] whatsapp-session directory already exists${NC}"
    fi
    
    # Create data directory if not exists
    if [ ! -d "data" ]; then
        mkdir -p data
        echo -e "${GREEN}[+] Created data directory${NC}"
    else
        echo -e "${BLUE}[i] data directory already exists${NC}"
    fi
}

# Setup settings.json
setup_settings() {
    echo -e "${CYAN}[*] Setting up settings.json...${NC}"
    
    if [ ! -f "settings.json" ]; then
        if [ -f "settings.server.template.json" ]; then
            cp settings.server.template.json settings.json
            echo -e "${GREEN}[+] Created settings.json from template${NC}"
            echo -e "${YELLOW}[!] IMPORTANT: Edit settings.json with your configuration${NC}"
        else
            echo -e "${RED}[!] Template settings not found. Please create settings.json manually${NC}"
        fi
    else
        echo -e "${BLUE}[i] settings.json already exists${NC}"
    fi
}

# Setup database structure
setup_database() {
    echo -e "${CYAN}[*] Setting up database structure...${NC}"
    
    # Setup payment gateway tables
    if [ -f "scripts/add-payment-gateway-tables.js" ]; then
        echo -e "${BLUE}[i] Setting up payment gateway tables...${NC}"
        node scripts/add-payment-gateway-tables.js > /dev/null 2>&1 || true
    fi
    
    # Setup technician tables
    if [ -f "scripts/add-technician-tables.js" ]; then
        echo -e "${BLUE}[i] Setting up technician tables...${NC}"
        node scripts/add-technician-tables.js > /dev/null 2>&1 || true
    fi
    
    # Setup voucher revenue table
    if [ -f "scripts/create-voucher-revenue-table.js" ]; then
        echo -e "${BLUE}[i] Setting up voucher revenue table...${NC}"
        node scripts/create-voucher-revenue-table.js > /dev/null 2>&1 || true
    fi
    
    # Run migrations
    if [ -f "scripts/run-migrations.js" ]; then
        echo -e "${BLUE}[i] Running database migrations...${NC}"
        node scripts/run-migrations.js > /dev/null 2>&1 || true
    fi
    
    # Setup default data
    if [ -f "scripts/setup-default-data.js" ]; then
        echo -e "${BLUE}[i] Setting up default data...${NC}"
        node scripts/setup-default-data.js > /dev/null 2>&1 || true
    fi
    
    echo -e "${GREEN}[+] Database structure setup completed${NC}"
}

# Setup PM2 startup
setup_pm2_startup() {
    echo -e "${CYAN}[*] Setting up PM2 startup...${NC}"
    
    # Generate PM2 startup script
    $SUDO pm2 startup systemd -u $USER --hp $HOME > /tmp/pm2-startup.txt 2>&1 || true
    
    echo -e "${GREEN}[+] PM2 startup configured${NC}"
    echo -e "${YELLOW}[!] Note: Run 'pm2 save' after starting the app to enable auto-start${NC}"
}

# Main installation function
main() {
    detect_os
    
    # Check if Ubuntu 22.04
    if [[ "$OS" != "ubuntu" ]] || [[ "$OS_VERSION" != "22.04" ]]; then
        echo -e "${YELLOW}[!] Warning: This script is optimized for Ubuntu 22.04${NC}"
        echo -e "${YELLOW}[!] Detected: ${OS} ${OS_VERSION}${NC}"
        read -p "Continue anyway? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
    
    echo -e "${CYAN}[*] Starting installation process...${NC}"
    echo ""
    
    # Step 1: Update system
    update_system
    
    # Step 2: Install system dependencies
    install_system_dependencies
    
    # Step 3: Install Node.js
    install_nodejs
    
    # Step 4: Install PM2
    install_pm2
    
    # Step 5: Install npm dependencies
    install_npm_dependencies
    
    # Step 6: Setup directories
    setup_directories
    
    # Step 7: Setup settings.json
    setup_settings
    
    # Step 8: Setup database structure
    setup_database
    
    # Step 9: Setup PM2 startup
    setup_pm2_startup
    
    echo ""
    echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║              ✅ Installation Completed!                  ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${CYAN}📋 Next Steps:${NC}"
    echo ""
    echo -e "${YELLOW}1. Edit settings.json:${NC}"
    echo -e "   ${BLUE}nano settings.json${NC}"
    echo ""
    echo -e "${YELLOW}2. Configure your settings:${NC}"
    echo -e "   - Admin phone numbers"
    echo -e "   - Technician phone numbers"
    echo -e "   - GenieACS URL and credentials"
    echo -e "   - Mikrotik connection (if using API mode)"
    echo -e "   - RADIUS connection (if using RADIUS mode)"
    echo ""
    echo -e "${YELLOW}3. Start the application:${NC}"
    echo -e "   ${BLUE}npm start${NC}  (for testing)"
    echo -e "   ${BLUE}pm2 start app.js --name cvlmedia${NC}  (for production)"
    echo ""
    echo -e "${YELLOW}4. Access the web interface:${NC}"
    echo -e "   ${BLUE}http://localhost:3003${NC}"
    echo -e "   ${BLUE}http://YOUR_SERVER_IP:3003${NC}"
    echo ""
    echo -e "${YELLOW}5. Complete UI configuration:${NC}"
    echo -e "   See ${BLUE}SETUP_UI_GUIDE.md${NC} for detailed steps"
    echo ""
    echo -e "${CYAN}📚 Documentation:${NC}"
    echo -e "   - ${BLUE}SETUP_UI_GUIDE.md${NC} - Complete UI setup guide"
    echo -e "   - ${BLUE}RADIUS_MODE_README.md${NC} - RADIUS mode documentation"
    echo -e "   - ${BLUE}INSTALL.md${NC} - Installation guide"
    echo ""
    echo -e "${GREEN}🎉 Your billing system is ready to configure!${NC}"
    echo ""
}

# Run main function
main
