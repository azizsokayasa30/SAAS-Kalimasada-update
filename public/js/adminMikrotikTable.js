$(document).ready(function(){
    var table = $('#pppoeTable').DataTable({
        "deferRender": true,
        "pageLength": 25,
        "lengthMenu": [[10, 25, 50, 100, -1], [10, 25, 50, 100, 'Semua']],
        "responsive": true,
        "scrollX": true,
        "columnDefs": [
            {
                "targets": [0], // No column
                "responsivePriority": 1
            },
            {
                "targets": [1], // Username column
                "responsivePriority": 2
            },
            {
                "targets": [-1], // Action column (last column)
                "responsivePriority": 3,
                "orderable": false
            }
        ],
        language: {
            search: 'Cari Username:',
            lengthMenu: 'Tampilkan _MENU_ entri',
            info: 'Menampilkan _START_ sampai _END_ dari _TOTAL_ entri',
            paginate: {
                first: 'Pertama',
                last: 'Terakhir',
                next: 'Berikutnya',
                previous: 'Sebelumnya'
            },
            zeroRecords: 'Tidak ditemukan data yang cocok',
            infoEmpty: 'Menampilkan 0 sampai 0 dari 0 entri',
            infoFiltered: '(disaring dari _MAX_ total entri)'
        },
        initComplete: function() {
            var api = this.api();
            var usernameCol = 1;

            // Global search hanya mencari kolom Username
            var $searchInput = $(api.table().container()).find('.dataTables_filter input');
            $searchInput.attr('placeholder', 'Username...');
            // Lepas handler default DataTables, lalu search hanya ke kolom username
            $searchInput.off();
            $searchInput.on('keyup.mikrotikUsername input.mikrotikUsername', function() {
                api.column(usernameCol).search(this.value).draw();
            });
        }
    });

    window.pppoeDataTable = table;
});
