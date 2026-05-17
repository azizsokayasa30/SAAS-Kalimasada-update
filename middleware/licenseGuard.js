// middleware/licenseGuard.js
const licenseGuard = (req, res, next) => {
  const isPaid = process.env.APP_ACTIVE === 'true'; // Cek dari .env

  if (!isPaid) {
    return res.status(402).json({
      status: false,
      message: "Payment Required: Please contact the developer to activate your license."
    });
  }
  next();
};

module.exports = licenseGuard;
